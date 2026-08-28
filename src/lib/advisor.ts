import type { Account, CardProduct, CategoryId, CreditUsage, PointsBalance, Transaction } from '../types';
import { MERCHANTS, searchMerchants, type MerchantEntry } from '../data/merchants';
import { productById } from '../data/cards';
import { categoryDef } from '../data/categories';
import { programById } from '../data/programs';
import { bonusProgressFor, type BonusProgress } from './bonus';
import { categorize } from './categorize';
import { creditsForAccount, todayIso, type CreditStatus } from './credits';
import { fmtCents, fmtNum, fmtUsd, fmtUsdWhole } from './format';
import { coverPoints, programLabel } from './loyalty';
import {
  headlineRateGap,
  inferMerchantKind,
  rewardMultiplierFor,
  rewardValueCents,
  type EarnContext,
  type HeadlineGap,
} from './rewards';

// ---------------------------------------------------------------------------
// Purchase advisor.
//
// The advisor is bonus-aware and credit-aware:
//  - While a card's welcome bonus is in progress, spend on it is worth an extra
//    bonus.valueCents / minSpend per dollar (see lib/bonus.ts boostPerDollarCents),
//    which usually beats any category multiplier — the advisor says so plainly.
//  - If a merchant matches an unused credit on a card (Uber Cash, airline fee
//    credit, Resy...), that card wins for the first $remaining of the purchase.
//  - Network acceptance (no Amex at Costco) disqualifies cards.
//
// Worked example — $200 at Costco with the demo wallet:
//   Amex Gold      blocked ("Costco doesn't accept American Express")
//   Sapphire Pref  1x × 1.5¢ = 300¢
//   Double Cash    2% × 1.0¢ = 400¢  ← best (unless a bonus boost flips it)
//
// Every function here is pure and must survive empty inputs: no accounts, no
// balances, no merchant match, zero amounts. Nothing divides by an unchecked
// denominator.

export interface PurchaseContext {
  accounts: Account[];
  transactions: Transaction[];
  creditUsages: CreditUsage[];
  pointsBalances: PointsBalance[];
  today?: string;
}

/** What the user is buying, resolved from a free-text query or a merchant entry. */
export interface PurchaseTarget {
  label: string; // 'Costco' or the raw query
  category: CategoryId;
  merchant?: MerchantEntry;
}

export interface CardOption {
  account: Account;
  product: CardProduct;
  /** points or cents earned on the purchase amount at the card's rate */
  multiplier: number;
  rewardValueCents: number;
  /** extra value from welcome-bonus progress on this purchase (0 if none) */
  bonusBoostCents: number;
  /** value of a credit this purchase would consume (0 if none) */
  creditValueCents: number;
  totalValueCents: number;
  /** short human reasons, best first: '4x dining', 'Counts toward your 60k bonus ($1,900 to go)', 'Uses $10 Uber Cash' */
  reasons: string[];
  /** hard blockers: 'Costco does not accept Amex' */
  blockers: string[];
}

export interface PurchaseAdvice {
  target: PurchaseTarget;
  amount: number;
  options: CardOption[]; // sorted best first, blocked cards last
  best: CardOption | null;
  /** things worth knowing regardless of card: portal bonuses, no-Amex, etc. */
  tips: string[];
}

// ------------------------------------------------------------- small utils --

const NETWORK_NAMES: Record<CardProduct['network'], string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
};

/** '1.5' not '1.50', '2' not '2.00'. */
function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** $10 for whole dollars, $10.50 otherwise. */
function money(n: number): string {
  return Number.isInteger(n) ? fmtUsdWhole(n) : fmtUsd(n);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function uniq(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const clean = s.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function tokensOf(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function safeRegex(source: string | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

/** Tokens too generic to link a credit to a merchant on their own. */
const GENERIC_CREDIT_TOKENS = new Set([
  'credit',
  'credits',
  'card',
  'cardmember',
  'annual',
  'monthly',
  'quarterly',
  'semiannual',
  'promo',
  'promos',
  'the',
  'and',
  'for',
  'plus',
  'cash',
  'back',
  'fee',
  'fees',
  'benefit',
  'bundle',
  'membership',
  'statement',
  'travel', // handled by the airline/hotel/portal special case below
  'dining',
  'hotel',
  'hotels',
  'stays',
  'entertainment',
  'digital',
  'exclusive',
  'tables',
  'groceries',
  'grocery',
  'shopping',
  'transit',
  'wireless',
  'streaming',
  'ring',
  'one',
  'air',
  'airline',
  'airlines',
  'music',
  'apple',
]);

const TRAVEL_MERCHANT_KINDS = new Set(['airline', 'hotel', 'travel-portal']);

// --------------------------------------------------------------- targeting --

/** Title-case a free-text query the user typed all in lowercase ('dinner' → 'Dinner'). */
function prettyQuery(q: string): string {
  if (q !== q.toLowerCase()) return q;
  return q
    .split(/(\s+)/)
    .map((part) => (/\s/.test(part) || part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('');
}

/**
 * Merchant context for the rewards engine. A co-brand's headline rate is
 * brand-limited, so the ranking is only honest once the engine knows WHAT is
 * being bought: id + program + kind when the directory matched, and the text
 * either way so pattern-scoped rules can still fire.
 */
function earnContextFor(target: PurchaseTarget, rawQuery: string): EarnContext {
  const merchant = target.merchant;
  // 'the lodge at whitefish' isn't in the directory but is plainly a hotel.
  // Infers the kind only, never a brand — see inferMerchantKind in lib/rewards.
  const kind =
    merchant?.kind ?? inferMerchantKind(`${target.label} ${rawQuery}`, target.category);
  return {
    ...(merchant ? { merchantId: merchant.id } : {}),
    ...(kind ? { kind } : {}),
    ...(merchant?.programId ? { programId: merchant.programId } : {}),
    merchantName: merchant?.name ?? target.label,
    rawDescription: rawQuery,
  };
}

/** '4x' or '2%', matching how the card's currency reads. */
function rateLabel(product: CardProduct, multiplier: number): string {
  return product.currency === 'cashback' ? `${trim(multiplier)}%` : `${trim(multiplier)}x`;
}

/** "Hilton Aspire's 14x applies to Hilton stays — this purchase earns 3x." */
function headlineGapTip(option: CardOption, gap: HeadlineGap): string {
  return `${option.account.name}'s ${rateLabel(option.product, gap.multiplier)} applies to ${
    gap.scope
  } — this purchase earns ${rateLabel(option.product, gap.applied)}.`;
}

/** Resolve free text ('costco', 'united.com', 'dinner') into a purchase target. */
export function resolveTarget(query: string): PurchaseTarget {
  const q = (query ?? '').trim();
  if (!q) return { label: '', category: 'other' };

  const merchant = searchMerchants(q, 1)[0];
  if (merchant) return { label: merchant.name, category: merchant.category, merchant };

  const { category } = categorize(q);
  return { label: prettyQuery(q), category };
}

// ----------------------------------------------------------------- reasons --

/** Always the first reason: '2% back ≈ 2.0¢/$' or '4x dining & drinks ≈ 6.4¢/$'. */
function rateReason(product: CardProduct, category: CategoryId, multiplier: number): string {
  const perDollar = (multiplier * product.pointValueCents).toFixed(1);
  if (product.currency === 'cashback') return `${trim(multiplier)}% back ≈ ${perDollar}¢/$`;
  const label = categoryDef(category).label.toLowerCase();
  return `${trim(multiplier)}x ${label} ≈ ${perDollar}¢/$`;
}

/** '60,000-point', '75,000-mile', '$200 cash'. */
function bonusSizeLabel(product: CardProduct, points: number): string {
  if (product.currency === 'cashback') return `${fmtUsdWhole(points / 100)} cash`;
  return `${fmtNum(points)}-${product.currency === 'miles' ? 'mile' : 'point'}`;
}

function bonusReason(progress: BonusProgress): string {
  const size = bonusSizeLabel(progress.product, progress.tracking.points);
  return `Counts toward your ${size} welcome bonus — ${money(progress.remaining)} to go, worth ≈${money(
    Math.round(progress.valueCents) / 100,
  )}`;
}

function creditReason(status: CreditStatus, applied: number): string {
  const resets =
    status.daysLeft <= 0
      ? 'resets today'
      : `resets in ${status.daysLeft} ${plural(status.daysLeft, 'day', 'days')}`;
  return `Uses ${money(applied)} of your ${money(status.credit.amount)} ${status.credit.name} (${resets})`;
}

// ----------------------------------------------------------------- credits --

/**
 * Does this credit actually offset this purchase?
 *   1. the credit's own matchPattern regex, against label + merchant + aliases + query
 *   2. a shared brand token between the credit id/name and the merchant name/aliases
 *      ('uber-cash' ↔ Uber and Uber Eats, 'doordash' ↔ DoorDash, 'lyft' ↔ Lyft)
 *   3. travel credits against airline / hotel / travel-portal merchants
 */
function creditMatchesTarget(credit: CreditStatus['credit'], target: PurchaseTarget, rawQuery: string): boolean {
  const merchant = target.merchant;
  const haystack = uniq([
    target.label,
    rawQuery,
    merchant?.name ?? '',
    ...(merchant?.aliases ?? []),
  ]).join(' ');

  const re = safeRegex(credit.matchPattern);
  if (re && haystack && re.test(haystack)) return true;

  const creditTokens = new Set(
    [...tokensOf(credit.id), ...tokensOf(credit.name)].filter(
      (t) => t.length >= 3 && !GENERIC_CREDIT_TOKENS.has(t),
    ),
  );
  if (merchant && creditTokens.size > 0) {
    const merchantTokens = new Set<string>();
    for (const t of tokensOf(merchant.name)) merchantTokens.add(t);
    for (const alias of merchant.aliases) for (const t of tokensOf(alias)) merchantTokens.add(t);
    for (const t of merchantTokens) if (creditTokens.has(t)) return true;
  }

  const isTravelCredit = [...tokensOf(credit.id), ...tokensOf(credit.name)].includes('travel');
  if (isTravelCredit && merchant && TRAVEL_MERCHANT_KINDS.has(merchant.kind)) return true;

  return false;
}

/** The single most valuable credit this purchase would consume, if any. */
function bestCreditFor(
  statuses: CreditStatus[],
  target: PurchaseTarget,
  rawQuery: string,
  amount: number,
): { status: CreditStatus; applied: number; valueCents: number } | null {
  let best: { status: CreditStatus; applied: number; valueCents: number } | null = null;
  for (const status of statuses) {
    if (status.remaining <= 0) continue;
    if (!creditMatchesTarget(status.credit, target, rawQuery)) continue;
    const applied = Math.min(amount, status.remaining);
    const valueCents = Math.round(applied * 100);
    if (valueCents <= 0) continue;
    if (
      !best ||
      valueCents > best.valueCents ||
      (valueCents === best.valueCents && status.daysLeft < best.status.daysLeft)
    ) {
      best = { status, applied, valueCents };
    }
  }
  return best;
}

// ------------------------------------------------------------------ advise --

function ownedCreditCards(accounts: Account[]): Array<{ account: Account; product: CardProduct }> {
  const out: Array<{ account: Account; product: CardProduct }> = [];
  for (const account of accounts ?? []) {
    if (account.type !== 'credit' || !account.productId) continue;
    const product = productById(account.productId);
    if (product) out.push({ account, product });
  }
  return out;
}

function compareOptions(a: CardOption, b: CardOption): number {
  const aBlocked = a.blockers.length > 0 ? 1 : 0;
  const bBlocked = b.blockers.length > 0 ? 1 : 0;
  if (aBlocked !== bBlocked) return aBlocked - bBlocked;
  if (b.totalValueCents !== a.totalValueCents) return b.totalValueCents - a.totalValueCents;
  if (a.product.annualFee !== b.product.annualFee) return a.product.annualFee - b.product.annualFee;
  return a.account.name.localeCompare(b.account.name);
}

/** Rank the user's cards for a purchase. amount defaults to $100 for per-dollar comparisons. */
export function advisePurchase(
  query: string | PurchaseTarget,
  amount: number,
  ctx: PurchaseContext,
): PurchaseAdvice {
  const target = typeof query === 'string' ? resolveTarget(query) : query;
  const rawQuery = typeof query === 'string' ? query.trim() : target.label;
  const amt = Number.isFinite(amount) && amount > 0 ? amount : 100;

  const accounts = ctx.accounts ?? [];
  const transactions = ctx.transactions ?? [];
  const creditUsages = ctx.creditUsages ?? [];
  const today = ctx.today ?? todayIso();

  const owned = ownedCreditCards(accounts);
  const earnCtx = earnContextFor(target, rawQuery);

  const built = owned.map(({ account, product }) => {
    const blockers: string[] = [];
    if (target.merchant?.rejectsNetworks?.includes(product.network)) {
      blockers.push(`${target.merchant.name} doesn't accept ${NETWORK_NAMES[product.network]}`);
    }

    // Merchant-accurate: Aspire earns 14x at a Hilton and 3x at a Hyatt, and
    // the ranking (and the rate reason below) has to say which one this is.
    const multiplier = rewardMultiplierFor(product, target.category, earnCtx);
    const reward = rewardValueCents(product, target.category, amt, earnCtx);
    const gap = headlineRateGap(product, target.category, earnCtx);

    // Welcome bonus still open? Every dollar carries extra value until it closes.
    let bonusBoostCents = 0;
    let bonusText = '';
    const progress = bonusProgressFor(account, transactions, today);
    if (progress && progress.status === 'in-progress' && progress.remaining > 0) {
      bonusBoostCents = Math.round(Math.min(amt, progress.remaining) * progress.boostPerDollarCents);
      if (bonusBoostCents > 0) bonusText = bonusReason(progress);
    }

    // Statement credit this purchase would burn down.
    let creditValueCents = 0;
    let creditText = '';
    const credit = bestCreditFor(
      creditsForAccount(account, creditUsages, transactions, today),
      target,
      rawQuery,
      amt,
    );
    if (credit) {
      creditValueCents = credit.valueCents;
      creditText = creditReason(credit.status, credit.applied);
    }

    // Rate first, then the extras in descending value order.
    const extras: Array<{ text: string; value: number }> = [];
    if (bonusText) extras.push({ text: bonusText, value: bonusBoostCents });
    if (creditText) extras.push({ text: creditText, value: creditValueCents });
    extras.sort((a, b) => b.value - a.value);

    const option: CardOption = {
      account,
      product,
      multiplier,
      rewardValueCents: reward,
      bonusBoostCents,
      creditValueCents,
      totalValueCents: reward + bonusBoostCents + creditValueCents,
      reasons: uniq([rateReason(product, target.category, multiplier), ...extras.map((e) => e.text)]),
      blockers,
    };
    return { option, gap };
  });

  const options: CardOption[] = built.map((b) => b.option);
  options.sort(compareOptions);

  const usable = options.filter((o) => o.blockers.length === 0);
  const best = usable[0] ?? null;
  const runnerUp = usable[1] ?? null;

  // Why a premium co-brand didn't win: its headline rate is brand-limited and
  // this purchase isn't the brand. Only worth saying when that headline rate
  // WOULD have beaten the winner — otherwise the card was never in contention.
  // Channel-scoped rates ("8x through Chase Travel") are skipped: that is
  // advice to book elsewhere, and the portal tip below already covers it.
  // Loudest two only — with eight cards, a hotel stay raises several at once.
  const bestValuePerDollar = best ? best.multiplier * best.product.pointValueCents : 0;
  const gapTips = built
    .filter((b): b is { option: CardOption; gap: HeadlineGap } => b.gap !== null)
    .filter((b) => b.option !== best && b.option.blockers.length === 0 && !b.gap.channelOnly)
    .map((b) => ({
      text: headlineGapTip(b.option, b.gap),
      headlineValuePerDollar: b.gap.multiplier * b.option.product.pointValueCents,
    }))
    .filter((g) => g.headlineValuePerDollar > bestValuePerDollar)
    .sort((a, b) => b.headlineValuePerDollar - a.headlineValuePerDollar)
    .slice(0, 2)
    .map((t) => t.text);

  const tips: string[] = [...gapTips, ...(target.merchant?.notes ?? [])];

  // The bonus is doing the work — say what happens once it closes.
  if (best && runnerUp && best.bonusBoostCents > 0) {
    if (best.totalValueCents - best.bonusBoostCents < runnerUp.totalValueCents) {
      tips.push(`After the bonus is done, ${runnerUp.account.name} is the better everyday card here.`);
    }
  }

  if (target.category === 'travel' && owned.some(({ product }) => product.programId === 'chase-ur')) {
    tips.push('Booking through Chase Travel earns more points but usually forfeits hotel elite credit.');
  }

  if (owned.length === 0) {
    tips.push('Add your credit cards on the Accounts page and Finch will rank them for every purchase.');
  }

  return { target, amount: amt, options, best, tips: uniq(tips) };
}

// ---------------------------------------------------------------------------
// Big purchases: flights & hotels — cash vs points vs transfers.

export interface BigPurchaseInput {
  kind: 'flight' | 'hotel' | 'other';
  /** airline/hotel program the booking belongs to, if known (e.g. 'united', 'hyatt') */
  programId?: string;
  cashPrice: number; // dollars
  /** points price quoted by the program, if the user looked it up */
  pointsPrice?: number;
  label?: string; // 'SFO→JFK in October'
}

export interface PaymentOption {
  id: string;
  title: string; // 'Pay cash with Amex Gold'
  /** net cost to the user in cents after rewards value / points value consumed */
  netCostCents: number;
  /** cents per point achieved when redeeming (undefined for cash) */
  centsPerPoint?: number;
  verdict: 'best' | 'good' | 'ok' | 'poor';
  details: string[]; // bullet explanations
  steps?: string[]; // e.g. 'Transfer 30,000 UR → Hyatt (1:1)'
}

export interface BigPurchasePlan {
  input: BigPurchaseInput;
  options: PaymentOption[]; // sorted best first
  summary: string; // one-paragraph recommendation
}

/** Cents per point you get redeeming a bank currency in its own travel portal. */
const PORTAL_RATES: Record<string, number> = {
  'chase-ur': 1.25,
  'amex-mr': 1.0,
  'capital-one': 1.0,
  'citi-ty': 1.0,
  bilt: 1.25,
};

const PORTAL_NAMES: Record<string, string> = {
  'chase-ur': 'Chase Travel',
  'amex-mr': 'Amex Travel',
  'capital-one': 'Capital One Travel',
  'citi-ty': 'Citi Travel',
  bilt: 'Bilt Travel',
};

const PORTAL_CAVEAT =
  "Flights booked this way still earn airline miles; hotels usually don't earn elite credit.";

const AWARD_TAX_CAVEAT = 'Award flights still cost ~$5.60–$100 in taxes and fees, not counted here';

function balanceOf(balances: PointsBalance[], programId: string): number {
  let total = 0;
  for (const b of balances ?? []) {
    if (b.programId !== programId) continue;
    if (!Number.isFinite(b.balance) || b.balance <= 0) continue;
    total += Math.floor(b.balance);
  }
  return total;
}

export function planBigPurchase(input: BigPurchaseInput, ctx: PurchaseContext): BigPurchasePlan {
  const cashPrice = Number.isFinite(input.cashPrice) && input.cashPrice > 0 ? input.cashPrice : 0;
  const cashCents = Math.round(cashPrice * 100);
  const pointsPrice =
    Number.isFinite(input.pointsPrice ?? NaN) && (input.pointsPrice ?? 0) > 0
      ? Math.round(input.pointsPrice as number)
      : 0;

  const accounts = ctx.accounts ?? [];
  const balances = ctx.pointsBalances ?? [];
  const program = input.programId ? programById(input.programId) : undefined;
  const merchant = input.programId ? MERCHANTS.find((m) => m.programId === input.programId) : undefined;

  // ---------------------------------------------------------------- (A) cash
  const target: PurchaseTarget = {
    label: input.label ?? program?.name ?? 'this purchase',
    category: input.kind === 'other' ? 'shopping' : 'travel',
    ...(merchant ? { merchant } : {}),
  };
  const cashAdvice = advisePurchase(target, cashPrice, ctx);
  const cashRewardCents = cashPrice > 0 ? cashAdvice.best?.totalValueCents ?? 0 : 0;

  const cashDetails = cashPrice > 0 ? [...(cashAdvice.best?.reasons ?? [])] : [];
  if (input.kind === 'flight') cashDetails.push('You still earn miles and elite credit on a paid fare');
  if (!cashAdvice.best) {
    cashDetails.push('No credit cards on file — add one on the Accounts page to earn on this.');
  }

  const cashOption: PaymentOption = {
    id: 'cash',
    title: cashAdvice.best ? `Pay cash with ${cashAdvice.best.account.name}` : 'Pay cash',
    netCostCents: cashCents - cashRewardCents,
    verdict: 'ok',
    details: uniq(cashDetails),
  };

  const feasible: PaymentOption[] = [cashOption];
  const trailing: PaymentOption[] = [];

  // ------------------------------------------------------- (B) award booking
  let awardOption: PaymentOption | null = null;
  let awardCovered = false;
  let awardShortfall = 0;
  let awardCpp = 0;
  if (program && pointsPrice > 0) {
    awardCpp = cashCents / pointsPrice;
    const cover = coverPoints(program.id, pointsPrice, balances);
    awardCovered = cover.covered;
    awardShortfall = cover.shortfall;

    const details = [
      `You'd get ${awardCpp.toFixed(1)}¢ per point; your ${programLabel(program)} ${program.unit} are worth ~${trim(
        program.valueCents,
      )}¢`,
    ];
    if (!cover.covered) {
      details.push(
        `Short ${fmtNum(cover.shortfall)} ${program.unit} — even after transfers you can't book this award today`,
      );
    }
    if (input.kind === 'flight') details.push(AWARD_TAX_CAVEAT);

    awardOption = {
      id: 'award',
      title: `Book with ${programLabel(program)} ${program.unit}`,
      netCostCents: Math.round(pointsPrice * program.valueCents),
      centsPerPoint: awardCpp,
      verdict: 'poor',
      details: uniq(details),
      steps: uniq(cover.steps.map((s) => s.label)),
    };

    if (cover.covered) feasible.push(awardOption);
    else trailing.push(awardOption);
  }

  // ------------------------------------------------- (C) bank travel portals
  // Bank portals only sell travel, so they are not an option for 'other'.
  const ownsReserve = ownedCreditCards(accounts).some((c) => c.product.id === 'chase-sapphire-reserve');
  if (cashCents > 0 && input.kind !== 'other') {
    for (const [bankId, baseRate] of Object.entries(PORTAL_RATES)) {
      const bank = programById(bankId);
      if (!bank) continue;
      const rate = bankId === 'chase-ur' && ownsReserve ? 1.5 : baseRate;
      if (rate <= 0) continue;
      const pointsNeeded = Math.ceil(cashCents / rate);
      const held = balanceOf(balances, bankId);
      if (held < pointsNeeded || pointsNeeded <= 0) continue;

      feasible.push({
        id: `portal-${bankId}`,
        title: `Book through ${PORTAL_NAMES[bankId] ?? bank.name}`,
        netCostCents: Math.round(pointsNeeded * bank.valueCents),
        centsPerPoint: rate,
        verdict: 'ok',
        details: uniq([`${fmtNum(pointsNeeded)} ${bank.short} at ${trim(rate)}¢`, PORTAL_CAVEAT]),
      });
    }
  }

  // -------------------------------------------- (D) informational breakeven
  let breakeven: PaymentOption | null = null;
  let breakevenPoints = 0;
  if (program && pointsPrice <= 0 && program.valueCents > 0 && cashCents > 0) {
    breakevenPoints = Math.floor(cashCents / program.valueCents);
    breakeven = {
      id: 'breakeven',
      title: 'Check the award price',
      netCostCents: cashOption.netCostCents,
      verdict: 'ok',
      details: uniq([
        `At ~${trim(program.valueCents)}¢ per point, using points beats cash only if the award costs ≤ ${fmtNum(
          breakevenPoints,
        )} ${program.short} ${program.unit}`,
        "Look it up on the program's site, then re-run this with the award price.",
      ]),
    };
  }

  // ------------------------------------------------------------------ rank
  feasible.sort((a, b) => a.netCostCents - b.netCostCents || a.title.localeCompare(b.title));
  const winner = feasible[0] ?? null;
  if (winner) {
    const base = Math.max(Math.abs(winner.netCostCents), 1);
    for (const option of feasible) {
      if (option === winner) {
        option.verdict = 'best';
        continue;
      }
      const over = (option.netCostCents - winner.netCostCents) / base;
      option.verdict = over <= 0.15 ? 'good' : over <= 0.4 ? 'ok' : 'poor';
    }
  }

  const options: PaymentOption[] = [...feasible];
  if (breakeven) options.splice(Math.min(1, options.length), 0, breakeven);
  options.push(...trailing);

  // --------------------------------------------------------------- summary
  const sentences: string[] = [];

  const bonusLead = bonusLeadSentence(ctx, cashPrice, cashAdvice.best?.account.id);
  if (bonusLead) sentences.push(bonusLead);

  if (winner) {
    const cpp =
      winner.centsPerPoint !== undefined ? ` at ${trim(Math.round(winner.centsPerPoint * 10) / 10)}¢ per point` : '';
    sentences.push(`${winner.title} nets out cheapest — ${fmtCents(winner.netCostCents)}${cpp}.`);
  }

  const runnerUp = feasible[1];
  if (winner && runnerUp) {
    const diff = runnerUp.netCostCents - winner.netCostCents;
    sentences.push(
      diff > 0
        ? `That beats the next best option — ${runnerUp.title} — by ${fmtCents(diff)}.`
        : `It ties the next option, ${runnerUp.title}, so take whichever is easier to book.`,
    );
  } else if (awardOption && !awardCovered && program) {
    sentences.push(
      `The ${fmtNum(pointsPrice)}-${program.unit.replace(/s$/, '')} award would run ${awardCpp.toFixed(
        1,
      )}¢ per point, but you're ${fmtNum(awardShortfall)} ${program.unit} short even after transfers.`,
    );
  } else if (breakeven && program) {
    sentences.push(
      `Points only beat cash here below ${fmtNum(breakevenPoints)} ${program.short} ${program.unit} — look up the award and re-run this.`,
    );
  } else if (input.kind === 'other') {
    sentences.push('Points and travel portals do not apply here, so the only lever is which card you pay with.');
  } else {
    sentences.push('Add points balances on the Points page and Finch can weigh award and portal bookings too.');
  }

  const summary =
    sentences.filter(Boolean).join(' ').trim() ||
    'Enter a cash price and Finch will compare paying cash, transferring points, and booking through a bank portal.';

  return { input, options, summary };
}

/**
 * "Put this on your Amex Gold — it's $1,600 of the $1,900 you still need for the bonus."
 * Prefers the card the cash option already picked, then the most urgent open bonus.
 */
function bonusLeadSentence(ctx: PurchaseContext, cashPrice: number, preferredAccountId?: string): string {
  if (cashPrice <= 0) return '';
  const today = ctx.today ?? todayIso();
  const open: BonusProgress[] = [];
  for (const account of ctx.accounts ?? []) {
    const progress = bonusProgressFor(account, ctx.transactions ?? [], today);
    if (progress && progress.status === 'in-progress' && progress.remaining >= cashPrice) open.push(progress);
  }
  if (open.length === 0) return '';
  open.sort((a, b) => a.daysLeft - b.daysLeft || b.valueCents - a.valueCents);
  const pick = open.find((p) => p.account.id === preferredAccountId) ?? open[0];
  return `Put this on your ${pick.account.name} — it's ${money(cashPrice)} of the ${money(
    pick.remaining,
  )} you still need for the bonus.`;
}
