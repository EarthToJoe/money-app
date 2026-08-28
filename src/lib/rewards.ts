import type { Account, CardProduct, CategoryId, RewardRule, Settings, Transaction } from '../types';
import { CARD_PRODUCTS, productById } from '../data/cards';
import { REWARDABLE_CATEGORY_IDS, categoryDef } from '../data/categories';
import {
  MERCHANTS,
  merchantById,
  merchantsForProgram,
  type MerchantEntry,
  type MerchantKind,
} from '../data/merchants';
import {
  addMonths,
  currentMonthKey,
  isSpending,
  lastMonthKeys,
  monthKeyOf,
  spendingByCategory,
} from './analytics';
import { fmtUsdWhole } from './format';

// ---------------------------------------------------------------------------
// Rewards engine.
//
// Unified earning math (see src/types.ts):
//   points earned = spend dollars × multiplier
//   value cents   = points × pointValueCents      (cashback: pointValueCents 1)
//
// Sanity check — worked example:
//   Amex Gold (4x dining, pointValueCents 1.6) on a $50 restaurant charge:
//     multiplier 4 → points = 50 × 4 = 200 MR
//     value = 200 × 1.6 = 320 cents = $3.20   → rewardValueCents(gold, 'dining', 50) = 320
//   The same $50 on Citi Double Cash (flat 2%, pointValueCents 1):
//     points = 100 → value = 100 cents = $1.00
//   computeMissed on that txn (both cards owned, Double Cash used):
//     deltaValueCents = 320 − 100 = 220 → $2.20 left on the table.
//   Cap example: after $25,000 of groceries in a calendar year on the Gold,
//   further grocery spend drops to baseMultiplier 1 → a $100 grocery run then
//   earns 100 pts = 160 cents instead of 400 pts = 640 cents.

export interface RewardEarning {
  transactionId: string;
  accountId: string;
  productId: string;
  monthKey: string; // 'YYYY-MM'
  multiplier: number;
  points: number;
  valueCents: number;
}

export interface MissedReward {
  transactionId: string;
  usedAccountId: string;
  bestAccountId: string;
  bestProductId: string;
  deltaValueCents: number; // value lost by not using the best owned card
}

export interface CardRecommendation {
  product: CardProduct;
  /** Estimated first-year gain in cents vs. the user's current wallet (incremental rewards + signup bonus − annual fee). */
  firstYearValueCents: number;
  /** Estimated ongoing annual gain in cents vs. the current wallet (incremental rewards − fee, no bonus). */
  annualValueCents: number;
  reason: string;
}

const REWARDABLE = new Set<CategoryId>(REWARDABLE_CATEGORY_IDS);

// ---------------------------------------------------------------------------
// Merchant context.
//
// A category alone cannot price a co-branded card: Hilton Aspire earns 14x at a
// Hilton and 3x at a Hyatt, and both post as 'travel'. Callers that know WHAT
// is being bought pass an EarnContext; callers that only know the category
// (annualised spend, a category picker) pass nothing and get the conservative
// rate the card pays everywhere else. See the RewardRule doc in src/types.ts
// for the full precedence.

export interface EarnContext {
  /** MerchantEntry.id from src/data/merchants.ts, when the merchant is known. */
  merchantId?: string;
  /** Display name, e.g. 'Hilton Garden Inn'. */
  merchantName?: string;
  /** Original statement text, e.g. 'HILTON GARDEN INN TYSONS'. */
  rawDescription?: string;
  /** MerchantEntry.programId — 'hilton', 'marriott', 'delta', 'united', 'hyatt'... */
  programId?: string;
  /** MerchantEntry.kind — 'airline', 'hotel', 'travel-portal', 'store'... */
  kind?: string;
}

/** Does this rule limit itself to particular merchants? */
function isScoped(rule: RewardRule): boolean {
  return Boolean(
    (rule.merchantIds && rule.merchantIds.length > 0) ||
      (rule.programIds && rule.programIds.length > 0) ||
      (rule.merchantKinds && rule.merchantKinds.length > 0) ||
      rule.merchantPattern,
  );
}

function safeRegex(source: string): RegExp | null {
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

/** Cache compiled merchantPattern regexes — rules are matched per transaction. */
const PATTERN_CACHE = new Map<string, RegExp | null>();
function patternFor(source: string): RegExp | null {
  if (!PATTERN_CACHE.has(source)) PATTERN_CACHE.set(source, safeRegex(source));
  return PATTERN_CACHE.get(source) ?? null;
}

/**
 * Does the purchase satisfy a scoped rule? The declared fields are OR'd — one
 * hit is enough, which is how "3x on Delta purchases OR hotels booked direct"
 * is expressed as a single rule.
 */
function contextMatchesRule(rule: RewardRule, ctx: EarnContext | undefined): boolean {
  if (!ctx) return false; // no context → a scoped rule cannot claim the purchase

  if (rule.merchantIds && ctx.merchantId && rule.merchantIds.includes(ctx.merchantId)) return true;
  if (rule.programIds && ctx.programId && rule.programIds.includes(ctx.programId)) return true;
  if (rule.merchantKinds && ctx.kind && (rule.merchantKinds as string[]).includes(ctx.kind)) {
    return true;
  }

  if (rule.merchantPattern) {
    const re = patternFor(rule.merchantPattern);
    if (re) {
      const entry = ctx.merchantId ? merchantById(ctx.merchantId) : undefined;
      const haystack = [
        ctx.merchantName ?? '',
        ctx.rawDescription ?? '',
        entry?.name ?? '',
        ...(entry?.aliases ?? []),
      ]
        .filter(Boolean)
        .join(' ');
      if (haystack && re.test(haystack)) return true;
    }
  }

  return false;
}

/**
 * Index of the first rule matching the category AND the merchant context, or -1
 * if none applies. Non-rewardable categories (housing, fees) never match
 * elevated rules. An unscoped rule matches on category alone.
 */
function firstMatchingRuleIndex(
  product: CardProduct,
  category: CategoryId,
  ctx?: EarnContext,
): number {
  if (!REWARDABLE.has(category)) return -1;
  for (let i = 0; i < product.rules.length; i++) {
    const rule = product.rules[i];
    const cats = rule.categories;
    if (cats !== 'all' && !cats.includes(category)) continue;
    if (isScoped(rule) && !contextMatchesRule(rule, ctx)) continue;
    return i;
  }
  return -1;
}

/**
 * Effective multiplier this product pays on a category.
 *
 * Without `ctx` the card's SCOPED rules are skipped, so a co-brand reports the
 * rate it pays away from its own brand (Aspire 3x, not 14x). That is deliberate:
 * an unscoped caller genuinely does not know the purchase is a Hilton stay, and
 * quoting the brand rate anyway overstates every other travel purchase.
 */
export function rewardMultiplierFor(
  product: CardProduct,
  category: CategoryId,
  ctx?: EarnContext,
): number {
  const idx = firstMatchingRuleIndex(product, category, ctx);
  return idx >= 0 ? product.rules[idx].multiplier : product.baseMultiplier;
}

/** Value in cents this product pays on `amount` dollars of `category` spend. */
export function rewardValueCents(
  product: CardProduct,
  category: CategoryId,
  amount: number,
  ctx?: EarnContext,
): number {
  // dollars × (points/dollar) × (cents/point) = cents; round once, at the end.
  return Math.round(amount * rewardMultiplierFor(product, category, ctx) * product.pointValueCents);
}

// ------------------------------------------------------- explaining a scope --

const KIND_PHRASE: Partial<Record<MerchantKind, string>> = {
  airline: 'flights booked direct with the airline',
  hotel: 'hotels booked direct',
  'travel-portal': 'bookings made through the portal',
  restaurant: 'restaurants',
  store: 'in-store purchases',
  warehouse: 'warehouse clubs',
  gas: 'gas stations',
  transit: 'transit',
  rideshare: 'rideshare',
  streaming: 'streaming services',
};

function joinOr(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/**
 * Plain-English description of what a scoped rule is limited to — 'Hilton
 * stays', 'flights booked direct with the airline or Amex Travel', 'Amazon'.
 * Returns '' for an unscoped rule.
 */
export function describeRuleScope(rule: RewardRule): string {
  const parts: string[] = [];

  for (const programId of rule.programIds ?? []) {
    const brand = merchantsForProgram(programId)[0];
    if (!brand) {
      parts.push(programId);
      continue;
    }
    parts.push(brand.kind === 'hotel' ? `${brand.name} stays` : `${brand.name} purchases`);
  }
  for (const kind of rule.merchantKinds ?? []) {
    parts.push(KIND_PHRASE[kind] ?? `${kind} purchases`);
  }
  for (const id of rule.merchantIds ?? []) {
    const entry = merchantById(id);
    if (entry) parts.push(entry.name);
  }
  if (parts.length === 0 && rule.merchantPattern) parts.push('select merchants');

  return joinOr(parts);
}

export interface HeadlineGap {
  /** The brand-limited rate the card advertises for this category. */
  multiplier: number;
  /** What the purchase actually earns. */
  applied: number;
  /** Where the headline rate does apply, e.g. 'Hilton stays'. */
  scope: string;
  /**
   * True when the headline rate is about the booking CHANNEL rather than the
   * merchant — Sapphire Reserve's 8x is "book it through Chase Travel", not
   * "this isn't a Chase hotel". Callers explaining why a card lost usually want
   * to skip these: they are advice to book somewhere else, and the portals
   * cannot sell most merchants anyway.
   */
  channelOnly: boolean;
}

/** A rule scoped ONLY to portal merchants describes a booking channel, not a brand. */
function isChannelScoped(rule: RewardRule): boolean {
  if (rule.programIds?.length || rule.merchantKinds?.length) return false;
  const ids = rule.merchantIds ?? [];
  if (ids.length === 0) return false;
  return ids.every((id) => merchantById(id)?.kind === 'travel-portal');
}

/**
 * The card's best SCOPED rate for a category that this purchase does NOT get,
 * or null when nothing was lost. Drives "Aspire's 14x is Hilton-only — this
 * stay earns 3x." Only reports a rule that would actually beat what applied.
 */
export function headlineRateGap(
  product: CardProduct,
  category: CategoryId,
  ctx?: EarnContext,
): HeadlineGap | null {
  if (!REWARDABLE.has(category)) return null;
  const applied = rewardMultiplierFor(product, category, ctx);

  let best: RewardRule | null = null;
  for (const rule of product.rules) {
    const cats = rule.categories;
    if (cats !== 'all' && !cats.includes(category)) continue;
    if (!isScoped(rule)) continue;
    if (contextMatchesRule(rule, ctx)) continue; // this one did apply
    if (rule.multiplier <= applied) continue;
    if (!best || rule.multiplier > best.multiplier) best = rule;
  }
  if (!best) return null;

  const scope = describeRuleScope(best);
  if (!scope) return null;
  return { multiplier: best.multiplier, applied, scope, channelOnly: isChannelScoped(best) };
}

// --------------------------------------------------- resolving a merchant --

/** Lowercase, collapse punctuation to single spaces: "TRADER JOE'S #552" → "trader joe s 552". */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface MerchantKey {
  key: string; // normalized name or alias
  entry: MerchantEntry;
}

let MERCHANT_KEYS: MerchantKey[] | null = null;

/** Names + aliases, longest first so 'costco gas' beats 'costco'. */
function merchantKeys(): MerchantKey[] {
  if (!MERCHANT_KEYS) {
    const keys: MerchantKey[] = [];
    for (const entry of MERCHANTS) {
      for (const raw of [entry.name, ...entry.aliases]) {
        const key = normalizeText(raw);
        if (key.length >= 3) keys.push({ key, entry });
      }
    }
    keys.sort((a, b) => b.key.length - a.key.length);
    MERCHANT_KEYS = keys;
  }
  return MERCHANT_KEYS;
}

const RESOLVE_CACHE = new Map<string, MerchantEntry | null>();

/**
 * Match a transaction's merchant against the directory: exact name/alias first,
 * then the longest name/alias appearing as whole words in the merchant text or
 * the raw statement description ('HILTON GARDEN INN TYSONS' → Hilton). Whole
 * words only, so 'delta dental' never becomes Delta Air Lines.
 *
 * Returns null for anything unrecognised — the vast majority of transactions —
 * and the engine simply falls back to category-only rates for those.
 */
export function resolveMerchant(
  merchantName: string | undefined,
  rawDescription?: string,
): MerchantEntry | null {
  const name = normalizeText(merchantName ?? '');
  const raw = normalizeText(rawDescription ?? '');
  if (!name && !raw) return null;

  const cacheKey = `${name}|${raw}`;
  const cached = RESOLVE_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  let found: MerchantEntry | null = null;
  const haystack = ` ${name} ${raw} `;
  for (const { key, entry } of merchantKeys()) {
    // Substring hits need 4+ characters: three-letter keys ('max', 'ana') are
    // common English fragments and would mis-resolve real statement text.
    if (key === name || (key.length >= 4 && haystack.includes(` ${key} `))) {
      found = entry;
      break; // keys are longest-first, so the first hit is the most specific
    }
  }

  RESOLVE_CACHE.set(cacheKey, found);
  return found;
}

// The directory holds the big chains, not every independent property. Without
// a fallback, 'NAVY LODGE 050120' and 'THE LODGE AT WHITEFISH' would earn the
// Sapphire Reserve's base 1x when a hotel booked direct really earns 4x.
//
// This infers only the KIND, never a brand: it can satisfy a merchantKinds rule
// ("hotels booked direct") but never a programIds rule, so an unrecognised hotel
// can never claim Aspire's Hilton-only 14x. It is also limited to travel-category
// spend, which keeps 'Elks Lodge' and the like out of it.
const HOTEL_WORDS = /\b(hotel|hotels|inn|inns|lodge|lodging|resort|resorts|motel|suites|hostel)\b/i;
const AIRLINE_WORDS = /\b(airline|airlines|airways|air lines)\b/i;

/** Best-effort MerchantKind for text the directory didn't recognise. */
export function inferMerchantKind(text: string, category: CategoryId): 'hotel' | 'airline' | undefined {
  if (category !== 'travel' || !text) return undefined;
  if (HOTEL_WORDS.test(text)) return 'hotel';
  if (AIRLINE_WORDS.test(text)) return 'airline';
  return undefined;
}

/** EarnContext for a transaction, resolved against the merchant directory. */
export function earnContextFor(txn: Transaction): EarnContext {
  const entry = resolveMerchant(txn.merchant, txn.rawDescription);
  const kind =
    entry?.kind ?? inferMerchantKind(`${txn.merchant ?? ''} ${txn.rawDescription ?? ''}`, txn.category);
  return {
    ...(entry ? { merchantId: entry.id } : {}),
    ...(kind ? { kind } : {}),
    ...(entry?.programId ? { programId: entry.programId } : {}),
    merchantName: txn.merchant,
    rawDescription: txn.rawDescription,
  };
}

/** Credit accounts with a resolvable product, keyed by account id. */
function creditProductsByAccount(accounts: Account[]): Map<string, CardProduct> {
  const map = new Map<string, CardProduct>();
  for (const a of accounts) {
    if (a.type !== 'credit' || !a.productId) continue;
    const product = productById(a.productId);
    if (product) map.set(a.id, product);
  }
  return map;
}

/** Per-transaction earnings for all credit-card spending. */
export function computeEarnings(txns: Transaction[], accounts: Account[]): RewardEarning[] {
  const products = creditProductsByAccount(accounts);
  if (products.size === 0 || txns.length === 0) return [];

  const eligible = txns.filter(
    (t) => t.amount > 0 && isSpending(t) && products.has(t.accountId),
  );
  if (eligible.length === 0) return [];

  // Group per account so each card tracks its own annual caps.
  const byAccount = new Map<string, Transaction[]>();
  for (const t of eligible) {
    const list = byAccount.get(t.accountId);
    if (list) list.push(t);
    else byAccount.set(t.accountId, [t]);
  }

  const byTxnId = new Map<string, RewardEarning>();
  for (const [accountId, list] of byAccount) {
    const product = products.get(accountId)!;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    // Cumulative capped-rule spend, keyed `${calendarYear}:${ruleIndex}`.
    // APPROXIMATE cap handling: transactions are processed in date order per
    // calendar year; once cumulative spend in a rule's categories has passed
    // the cap, later transactions earn baseMultiplier. The transaction that
    // straddles the cap boundary is not split — it earns the elevated rate in
    // full. Refunds (negative amounts) are excluded and do not free up cap.
    const cappedSpend = new Map<string, number>();
    for (const t of sorted) {
      // Historical earnings use the REAL rate: a Hilton stay on the Aspire
      // earns 14x, a Hyatt stay on the same card earns 3x. Transactions whose
      // merchant isn't in the directory resolve to no context and fall back to
      // category-only rates rather than throwing.
      const ruleIdx = firstMatchingRuleIndex(product, t.category, earnContextFor(t));
      let multiplier = product.baseMultiplier;
      if (ruleIdx >= 0) {
        const rule = product.rules[ruleIdx];
        multiplier = rule.multiplier;
        if (rule.capPerYear !== undefined) {
          const key = `${t.date.slice(0, 4)}:${ruleIdx}`;
          const prior = cappedSpend.get(key) ?? 0;
          if (prior >= rule.capPerYear) multiplier = product.baseMultiplier;
          cappedSpend.set(key, prior + t.amount);
        }
      }
      const points = t.amount * multiplier;
      byTxnId.set(t.id, {
        transactionId: t.id,
        accountId,
        productId: product.id,
        monthKey: monthKeyOf(t.date),
        multiplier,
        points,
        valueCents: Math.round(points * product.pointValueCents),
      });
    }
  }

  // Preserve the caller's transaction ordering.
  return eligible.map((t) => byTxnId.get(t.id)!);
}

/**
 * Transactions where a different OWNED card would have earned more.
 * Caps are ignored here for simplicity — this is a per-transaction comparison.
 *
 * Each transaction resolves its own merchant, so the comparison is at the rate
 * the cards really pay there. Pass `ctx` to force one context onto every
 * transaction instead (useful for what-if questions about a single merchant).
 */
export function computeMissed(
  txns: Transaction[],
  accounts: Account[],
  ctx?: EarnContext,
): MissedReward[] {
  const products = creditProductsByAccount(accounts);
  if (products.size === 0 || txns.length === 0) return [];
  const owned = [...products.entries()].map(([accountId, product]) => ({ accountId, product }));

  const missed: MissedReward[] = [];
  for (const t of txns) {
    if (t.amount <= 0 || !isSpending(t)) continue;
    const usedProduct = products.get(t.accountId);
    if (!usedProduct) continue;
    const txnCtx = ctx ?? earnContextFor(t);
    const usedValue = rewardValueCents(usedProduct, t.category, t.amount, txnCtx);

    let best = owned[0];
    let bestValue = rewardValueCents(best.product, t.category, t.amount, txnCtx);
    for (let i = 1; i < owned.length; i++) {
      const v = rewardValueCents(owned[i].product, t.category, t.amount, txnCtx);
      if (
        v > bestValue ||
        (v === bestValue && owned[i].product.annualFee < best.product.annualFee)
      ) {
        best = owned[i];
        bestValue = v;
      }
    }

    if (bestValue - usedValue >= 1) {
      missed.push({
        transactionId: t.id,
        usedAccountId: t.accountId,
        bestAccountId: best.accountId,
        bestProductId: best.product.id,
        deltaValueCents: bestValue - usedValue,
      });
    }
  }
  return missed;
}

/**
 * Best owned credit card for a category, or null if user owns no credit cards.
 * With `ctx` the ranking uses the rate each card really pays at that merchant;
 * without it, brand-limited rates are skipped (the conservative default).
 */
export function bestOwnedCardFor(
  category: CategoryId,
  accounts: Account[],
  ctx?: EarnContext,
): { account: Account; product: CardProduct; multiplier: number; valuePerDollarCents: number } | null {
  let best: {
    account: Account;
    product: CardProduct;
    multiplier: number;
    valuePerDollarCents: number;
  } | null = null;
  for (const account of accounts) {
    if (account.type !== 'credit' || !account.productId) continue;
    const product = productById(account.productId);
    if (!product) continue;
    const multiplier = rewardMultiplierFor(product, category, ctx);
    const valuePerDollarCents = multiplier * product.pointValueCents;
    if (
      !best ||
      valuePerDollarCents > best.valuePerDollarCents ||
      (valuePerDollarCents === best.valuePerDollarCents &&
        product.annualFee < best.product.annualFee)
    ) {
      best = { account, product, multiplier, valuePerDollarCents };
    }
  }
  return best;
}

export interface RecommendOptions {
  /** Reads `waiveAnnualFees` — when true every product's fee is treated as $0. */
  settings?: Settings;
  /** Full override: what this cardholder would actually pay for a product, in dollars. */
  feeFor?: (product: CardProduct) => number;
}

/**
 * What this cardholder would actually pay for a product, in dollars.
 * feeFor wins, then the global waiver, then the published fee. A feeFor that
 * returns something that isn't a usable number falls back to the published fee.
 */
function resolveFee(product: CardProduct, opts?: RecommendOptions): number {
  if (opts?.feeFor) {
    const fee = opts.feeFor(product);
    if (typeof fee === 'number' && Number.isFinite(fee) && fee >= 0) return fee;
  }
  if (opts?.settings?.waiveAnnualFees) return 0;
  return product.annualFee;
}

/**
 * Cards (not already owned) ranked by estimated value on the user's actual
 * spending. `opts` adjusts what the cardholder really pays — an SCRA waiver
 * makes a $650 card free, which changes both the ranking and the wording.
 */
export function recommendNewCards(
  txns: Transaction[],
  accounts: Account[],
  trailingMonths = 6,
  opts?: RecommendOptions,
): CardRecommendation[] {
  if (txns.length === 0 || trailingMonths <= 0) return [];

  // Trailing FULL months (exclude the current partial month).
  const endKey = addMonths(currentMonthKey(), -1);
  const keys = lastMonthKeys(trailingMonths, endKey);
  const keySet = new Set(keys);

  // Annualize from months that actually contain spending, so a user with a
  // short history isn't diluted into looking like a light spender.
  const monthsWithData = new Set<string>();
  for (const t of txns) {
    if (t.amount > 0 && isSpending(t) && keySet.has(monthKeyOf(t.date))) {
      monthsWithData.add(monthKeyOf(t.date));
    }
  }
  if (monthsWithData.size === 0) return [];
  const annualFactor = 12 / monthsWithData.size;

  // Per-category spend in the window, rewardable categories only (housing and
  // fees typically can't be shifted onto a card; refunds net out).
  const annualSpendByCat = new Map<CategoryId, number>();
  for (const key of keys) {
    for (const { category, total } of spendingByCategory(txns, key)) {
      if (!REWARDABLE.has(category)) continue;
      annualSpendByCat.set(category, (annualSpendByCat.get(category) ?? 0) + total);
    }
  }
  let totalAnnualSpend = 0;
  for (const [cat, total] of annualSpendByCat) {
    const annual = total * annualFactor;
    annualSpendByCat.set(cat, annual);
    totalAnnualSpend += annual;
  }
  if (totalAnnualSpend <= 0) return [];

  const ownedIds = new Set([...creditProductsByAccount(accounts).values()].map((p) => p.id));

  const recs: CardRecommendation[] = [];
  for (const product of CARD_PRODUCTS) {
    if (ownedIds.has(product.id)) continue;

    // Incremental rewards from ADDING this card to the wallet: for each
    // category, the user would keep using whichever card pays more, so the
    // gain is max(0, newCard − bestOwned) × spend. Spend past a rule's annual
    // cap falls to the card's base rate (and is likewise only counted where
    // that beats the best owned card). With no owned cards, this is simply the
    // card's gross rewards.
    //
    // A year of annualised category spend has no single merchant, so every
    // lookup here is deliberately UNSCOPED: brand-limited rules are skipped on
    // both sides of the comparison. A hotel co-brand is therefore valued at the
    // rate it pays on ordinary travel, never at its 14x/6x brand headline.
    let gainCents = 0;
    for (const [cat, spend] of annualSpendByCat) {
      const idx = firstMatchingRuleIndex(product, cat);
      const owned = bestOwnedCardFor(cat, accounts);
      const ownedVpd = owned ? owned.valuePerDollarCents : 0;
      const baseVpd = product.baseMultiplier * product.pointValueCents;
      if (idx < 0) {
        gainCents += Math.max(0, baseVpd - ownedVpd) * spend;
        continue;
      }
      const rule = product.rules[idx];
      const elevated = rule.capPerYear !== undefined ? Math.min(spend, rule.capPerYear) : spend;
      const elevatedVpd = rule.multiplier * product.pointValueCents;
      gainCents += Math.max(0, elevatedVpd - ownedVpd) * elevated;
      gainCents += Math.max(0, baseVpd - ownedVpd) * (spend - elevated);
    }

    const fee = resolveFee(product, opts);
    const annualValueCents = Math.round(gainCents) - fee * 100;

    // Signup bonus counts only when the user's spend pace clears minSpend
    // within the bonus window.
    let bonusValueCents = 0;
    if (product.signupBonus) {
      const spendInWindow = totalAnnualSpend * (product.signupBonus.months / 12);
      if (spendInWindow >= product.signupBonus.minSpend) {
        bonusValueCents = Math.round(product.signupBonus.points * product.pointValueCents);
      }
    }
    const firstYearValueCents = annualValueCents + bonusValueCents;

    recs.push({
      product,
      firstYearValueCents,
      annualValueCents,
      reason: buildReason(
        product,
        annualSpendByCat,
        totalAnnualSpend,
        accounts,
        annualValueCents,
        bonusValueCents,
        fee,
      ),
    });
  }

  // Rank by estimated two-year gain (first year incl. bonus + one ongoing
  // year) so a big signup bonus can't carry a card that bleeds value after.
  const twoYear = (r: CardRecommendation) => r.firstYearValueCents + r.annualValueCents;
  return recs.sort((a, b) => twoYear(b) - twoYear(a)).slice(0, 6);
}

/** '1.5' not '1.50', '2' not '2.00'. */
function trimNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * "Its 14x headline rate applies only to Hilton stays..." — appended when the
 * card's advertised rate for a category the user actually spends in is
 * brand-limited, so the estimate above it deliberately used a lower rate.
 */
function brandLimitNote(
  product: CardProduct,
  annualSpendByCat: Map<CategoryId, number>,
): string {
  let best: { gap: HeadlineGap; category: CategoryId } | null = null;
  for (const [category, spend] of annualSpendByCat) {
    if (spend <= 0) continue;
    const gap = headlineRateGap(product, category); // no ctx — the unscoped view
    if (!gap) continue;
    if (!best || gap.multiplier > best.gap.multiplier) best = { gap, category };
  }
  if (!best) return '';
  const unit = product.currency === 'cashback' ? '%' : 'x';
  const label = categoryDef(best.category).label.toLowerCase();
  return ` Its headline ${trimNum(best.gap.multiplier)}${unit} applies only to ${best.gap.scope}, so this uses the ${trimNum(
    best.gap.applied,
  )}${unit} it pays on ${label} generally.`;
}

/**
 * One concrete sentence citing the user's actual spend, plus a note when the
 * card's headline rate is brand-limited. `fee` is what the cardholder would
 * really pay.
 */
function buildReason(
  product: CardProduct,
  annualSpendByCat: Map<CategoryId, number>,
  totalAnnualSpend: number,
  accounts: Account[],
  annualValueCents: number,
  bonusValueCents: number,
  fee: number,
): string {
  const core = buildReasonCore(
    product,
    annualSpendByCat,
    totalAnnualSpend,
    accounts,
    annualValueCents,
    bonusValueCents,
    fee,
  );
  return `${core}${brandLimitNote(product, annualSpendByCat)}`;
}

function buildReasonCore(
  product: CardProduct,
  annualSpendByCat: Map<CategoryId, number>,
  totalAnnualSpend: number,
  accounts: Account[],
  annualValueCents: number,
  bonusValueCents: number,
  fee: number,
): string {
  // Find the category where this card most out-earns the user's current best
  // owned card (spend clamped to the rule's annual cap where one applies).
  let bestCat: CategoryId | null = null;
  let bestAdvCents = 0;
  let bestSpend = 0;
  let bestMult = 0;
  let bestGrossCents = 0;
  let hasOwned = false;
  for (const [cat, spend] of annualSpendByCat) {
    const idx = firstMatchingRuleIndex(product, cat);
    const mult = idx >= 0 ? product.rules[idx].multiplier : product.baseMultiplier;
    const cap = idx >= 0 ? product.rules[idx].capPerYear : undefined;
    const effSpend = cap !== undefined ? Math.min(spend, cap) : spend;
    const cardVpd = mult * product.pointValueCents;
    const owned = bestOwnedCardFor(cat, accounts);
    if (owned) hasOwned = true;
    const ownedVpd = owned ? owned.valuePerDollarCents : 0;
    const advCents = (cardVpd - ownedVpd) * effSpend;
    if (advCents > bestAdvCents) {
      bestCat = cat;
      bestAdvCents = advCents;
      bestSpend = spend;
      bestMult = mult;
      bestGrossCents = cardVpd * effSpend;
    }
  }

  // Lead with the category edge when it is material (≥ $25/yr) and not dwarfed
  // by the signup bonus; otherwise lead with the bonus so the sentence
  // explains why the card actually ranks where it does.
  const bonusDominates = bonusValueCents > 0 && bonusValueCents >= 4 * bestAdvCents;

  // This cardholder pays nothing for a card the issuer prices at a real fee.
  // Say so — and never talk about "covering" a fee they don't pay. It leads the
  // sentence only when it changes the answer: the card would not have paid for
  // itself at the published price and does now.
  const waived = fee === 0 && product.annualFee > 0;
  if (waived && annualValueCents < product.annualFee * 100) {
    if (bestCat && bestAdvCents >= 2500 && !bonusDominates) {
      const label = categoryDef(bestCat).label.toLowerCase();
      return hasOwned
        ? `Free for you under the fee waiver — adds ~${fmtUsdWhole(bestAdvCents / 100)}/yr on your ${label} over your current best.`
        : `Free for you under the fee waiver — earns ~${fmtUsdWhole(bestGrossCents / 100)}/yr on your ${label} alone.`;
    }
    if (bonusValueCents > 0) {
      return `Free for you under the fee waiver — your ~${fmtUsdWhole(totalAnnualSpend)}/yr of card spending clears the ${fmtUsdWhole(product.signupBonus!.minSpend)} bonus requirement, and the bonus alone is worth ~${fmtUsdWhole(bonusValueCents / 100)}.`;
    }
    if (annualValueCents > 0) {
      return `Free for you under the fee waiver — adds ~${fmtUsdWhole(annualValueCents / 100)}/yr over your current cards on your ~${fmtUsdWhole(totalAnnualSpend)}/yr spending mix.`;
    }
    return `Free for you under the fee waiver, but on your spending mix it earns nothing your current cards don't already earn.`;
  }

  if (bestCat && bestAdvCents >= 2500 && !bonusDominates) {
    const label = categoryDef(bestCat).label.toLowerCase();
    const multText = product.currency === 'cashback' ? `${bestMult}%` : `${bestMult}x`;
    return hasOwned
      ? `You spent ~${fmtUsdWhole(bestSpend)}/yr on ${label}; this card's ${multText} would earn ~${fmtUsdWhole(bestAdvCents / 100)}/yr more than your current best.`
      : `You spent ~${fmtUsdWhole(bestSpend)}/yr on ${label}; this card's ${multText} would earn ~${fmtUsdWhole(bestGrossCents / 100)}/yr on that spend alone.`;
  }

  if (bonusValueCents > 0 && bonusValueCents >= annualValueCents) {
    const edge =
      bestCat && bestAdvCents >= 2500
        ? hasOwned
          ? `, plus ~${fmtUsdWhole(bestAdvCents / 100)}/yr more on your ${categoryDef(bestCat).label.toLowerCase()} than your current best`
          : `, plus ~${fmtUsdWhole(bestAdvCents / 100)}/yr on your ${categoryDef(bestCat).label.toLowerCase()}`
        : '';
    return `Your ~${fmtUsdWhole(totalAnnualSpend)}/yr of card-eligible spending clears the ${fmtUsdWhole(product.signupBonus!.minSpend)} bonus requirement — the signup bonus alone is worth ~${fmtUsdWhole(bonusValueCents / 100)}${edge}.`;
  }

  if (bestCat && bestAdvCents >= 100) {
    const label = categoryDef(bestCat).label.toLowerCase();
    const multText = product.currency === 'cashback' ? `${bestMult}%` : `${bestMult}x`;
    return `You spent ~${fmtUsdWhole(bestSpend)}/yr on ${label}; this card's ${multText} would earn ~${fmtUsdWhole(bestAdvCents / 100)}/yr more than your current best.`;
  }

  if (annualValueCents > 0) {
    const feeText = waived
      ? ', and its annual fee is waived for you'
      : fee > 0
        ? ` after the ${fmtUsdWhole(fee)} annual fee`
        : ' with no annual fee';
    return `Added to your wallet, this nets ~${fmtUsdWhole(annualValueCents / 100)}/yr on your ~${fmtUsdWhole(totalAnnualSpend)}/yr spending mix${feeText}.`;
  }

  if (waived) {
    return `Free for you under the fee waiver, but on your spending mix it earns nothing your current cards don't already earn.`;
  }
  return `On your spending mix, what this adds over your current cards doesn't cover its ${fmtUsdWhole(fee)} annual fee.`;
}
