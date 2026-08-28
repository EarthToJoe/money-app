import type { Account, CardProduct } from '../types';
import { CARD_PRODUCTS } from '../data/cards';
import { LOYALTY_PROGRAMS } from '../data/programs';

// ---------------------------------------------------------------------------
// Card identification — mapping a linked bank account to a CardProduct.
//
// Plaid hands us the issuer's own account label, which ranges from perfectly
// descriptive ("Marriott Bonvoy Brilliant® American Express® Card") to useless
// ("Ultimate Rewards®" — which is what Chase calls BOTH of this user's
// Sapphire-family cards). Nothing in the rewards engine works until an account
// carries a productId, so this module does the guessing and the UI does the
// confirming. It never writes: a guess is a suggestion the user accepts.
//
// Design notes:
// - Matching is done against CARD_PRODUCTS *by name*, never by a hardcoded id
//   table, so the matcher improves for free every time a product is added.
// - Token weights come from document frequency across the product database
//   (a token in one product name is far more identifying than one in eight),
//   with a curated boost for the words that name a card line.
// - Tokens the ACCOUNT has and the product lacks are penalised hard ("Aspire"
//   is strong evidence the card is not the Surpass). Tokens the PRODUCT has and
//   the account lacks are penalised gently, because issuer labels are routinely
//   truncated ("Prime Visa" is really the Amazon Prime Visa; "Platinum Card" is
//   really The Platinum Card).
// - Issuer compatibility is a hard gate, so an Amex account can never be
//   matched to a Chase product, no matter how the names line up.
//
// Everything here is pure: no React, no store, no I/O. Odd input (missing
// fields, empty names, non-credit accounts) returns null rather than throwing.

export interface CardMatch {
  productId: string;
  confidence: 'high' | 'medium' | 'low';
  why: string;
}

// ---------------------------------------------------------------------------
// Normalisation

const SYMBOLS = /[®™©℠]/g;

/** Dropped entirely — they carry no information about which card this is. */
const STOPWORDS = new Set([
  'card',
  'cards',
  'credit',
  'the',
  'a',
  'an',
  'and',
  'of',
  'my',
  'for',
  'with',
  'inc',
  'llc',
  'co',
]);

/** Kept as tokens, but weighted near zero: too common across the market to identify a product. */
const GENERIC = new Set([
  'rewards',
  'reward',
  'points',
  'point',
  'miles',
  'mile',
  'bank',
  'visa',
  'mastercard',
  'signature',
  'infinite',
  'elite',
  'member',
  'members',
  'business',
  'personal',
  'national',
  'account',
  'one',
  'world',
  'plus',
]);

/**
 * Words that name a card *line*. Matching one of these is the difference
 * between "some Hilton card" and "the Hilton Aspire", so they are boosted
 * above whatever their document frequency alone would earn.
 */
const DISTINCTIVE = new Set([
  'brilliant',
  'aspire',
  'surpass',
  'boundless',
  'bevy',
  'bountiful',
  'reserve',
  'platinum',
  'gold',
  'green',
  'blue',
  'explorer',
  'quest',
  'club',
  'venture',
  'sapphire',
  'freedom',
  'flex',
  'unlimited',
  'prime',
  'amazon',
  'preferred',
  'everyday',
  'premier',
  'strata',
  'custom',
  'double',
  'active',
  'savor',
  'savorone',
  'quicksilver',
  'bonvoy',
  'marriott',
  'hilton',
  'honors',
  'hyatt',
  'ihg',
  'delta',
  'skymiles',
  'united',
  'southwest',
  'jetblue',
  'alaska',
  'bilt',
  'discover',
  'x',
]);

/** Single letters are punctuation debris ("U.S. Bank") — except the Venture X's X. */
const KEEP_SHORT = new Set(['x']);

/**
 * Generic issuer labels that name no product at all. Chase reports both of this
 * user's Sapphire-family cards as "Ultimate Rewards®"; Amex uses "Membership
 * Rewards" the same way. A name built only from these words must never produce
 * a confident guess — the UI asks instead.
 */
const AMBIGUOUS_ONLY = new Set([
  ...GENERIC,
  'ultimate',
  'membership',
  'cash',
  'back',
  'travel',
  'everyday', // "Everyday Card" alone is not enough to pick a product
  'classic',
  'standard',
  'basic',
  'main',
  'primary',
  'joint',
  'authorized',
  'user',
]);

function stripSymbols(s: unknown): string {
  return typeof s === 'string' ? s.replace(SYMBOLS, ' ') : '';
}

/** Raw words of a name, original casing, punctuation removed. */
function rawWords(s: unknown): string[] {
  return stripSymbols(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/**
 * Name -> comparable tokens. Lowercases, strips ®™©, punctuation, the words
 * "card"/"credit"/"the", the phrase "american express" (and "amex"), plus the
 * issuer's own name — both sides drop their issuer so "Chase Sapphire
 * Preferred" and "Sapphire Preferred" tokenize identically.
 */
function tokenize(name: unknown, issuerName?: unknown): string[] {
  let s = stripSymbols(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  s = s.replace(/\bamerican express\b/g, ' ').replace(/\bamex\b/g, ' ');
  const issuerTokens = new Set(
    stripSymbols(issuerName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(Boolean),
  );
  const out: string[] = [];
  for (const t of s.split(' ')) {
    if (!t) continue;
    if (STOPWORDS.has(t)) continue;
    if (issuerTokens.has(t)) continue;
    if (t.length < 2 && !KEEP_SHORT.has(t)) continue;
    if (/^\d+$/.test(t)) continue; // account numbers / masks are not card names
    out.push(t);
  }
  return out;
}

function tokenSet(name: unknown, issuerName?: unknown): Set<string> {
  return new Set(tokenize(name, issuerName));
}

// ---------------------------------------------------------------------------
// Issuer compatibility (a hard gate)

/**
 * All issuer keys a bank/issuer string implies. Multi-issuer products come back
 * with several ("Bilt / Wells Fargo" -> bilt + wells-fargo) so either side of
 * the partnership counts as compatible.
 */
function issuerKeys(raw: unknown): Set<string> {
  const s = stripSymbols(raw).toLowerCase();
  const keys = new Set<string>();
  if (!s.trim()) return keys;
  const has = (re: RegExp) => re.test(s);
  if (has(/american express|amex/)) keys.add('amex');
  if (has(/chase|jpmorgan|j\.?p\.? morgan/)) keys.add('chase');
  if (has(/\bciti\b|citibank|citigroup/)) keys.add('citi');
  if (has(/capital one/)) keys.add('capital-one');
  if (has(/discover/)) keys.add('discover');
  if (has(/wells fargo/)) keys.add('wells-fargo');
  if (has(/u\.?s\.? bank|usbank/)) keys.add('us-bank');
  if (has(/\bbilt\b/)) keys.add('bilt');
  if (has(/bank of america/)) keys.add('bofa');
  if (has(/barclay/)) keys.add('barclays');
  if (has(/synchrony/)) keys.add('synchrony');
  if (has(/\bapple\b|goldman/)) keys.add('goldman');
  return keys;
}

/** Unknown issuer on either side means "can't rule it out", not "no". */
function issuerCompatible(accountKeys: Set<string>, productKeys: Set<string>): boolean {
  if (accountKeys.size === 0 || productKeys.size === 0) return true;
  for (const k of accountKeys) if (productKeys.has(k)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Token weights, derived from the product database itself

interface ProductIndex {
  products: CardProduct[];
  tokens: Array<Set<string>>;
  df: Map<string, number>;
  issuers: Array<Set<string>>;
}

const indexCache = new WeakMap<readonly CardProduct[], ProductIndex>();

function buildIndex(products: readonly CardProduct[]): ProductIndex {
  const cached = indexCache.get(products);
  if (cached) return cached;
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  const tokens = list.map((p) => tokenSet(p?.name, p?.issuer));
  const issuers = list.map((p) => issuerKeys(p?.issuer));
  const df = new Map<string, number>();
  for (const set of tokens) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const idx: ProductIndex = { products: list, tokens, df, issuers };
  indexCache.set(products, idx);
  return idx;
}

/**
 * How much a token is worth as evidence. Rare across the product database =
 * identifying; common = noise. A token in no product at all still gets real
 * weight (3) — "aspire" was unknown to Finch before the Aspire was added, and
 * the right behaviour then is "this is not the Surpass", not "close enough".
 */
function weightOf(token: string, df: Map<string, number>): number {
  if (GENERIC.has(token)) return 0.3;
  const n = df.get(token) ?? 0;
  let w: number;
  if (n === 0) w = 3;
  else if (n === 1) w = 6;
  else if (n === 2) w = 4.5;
  else if (n <= 4) w = 3;
  else w = 1.5;
  if (DISTINCTIVE.has(token)) w *= 1.6;
  return w;
}

/** A token worth acting on: it names a line, not a marketing suffix. */
const DISTINCTIVE_WEIGHT = 4;

const ACCOUNT_ONLY_PENALTY = 1.0; // "Aspire" missing from the product: strong evidence against
const PRODUCT_ONLY_PENALTY = 0.3; // "Amazon" missing from the account label: issuers truncate

interface Scored {
  product: CardProduct;
  score: number;
  shared: Set<string>;
  accountOnly: Set<string>;
  sharedDistinctive: boolean;
  accountOnlyDistinctive: boolean;
}

function scoreProduct(
  accountTokens: Set<string>,
  productTokens: Set<string>,
  df: Map<string, number>,
  product: CardProduct,
): Scored {
  const shared = new Set<string>();
  const accountOnly = new Set<string>();
  let score = 0;
  let sharedDistinctive = false;
  let accountOnlyDistinctive = false;

  for (const t of accountTokens) {
    const w = weightOf(t, df);
    if (productTokens.has(t)) {
      shared.add(t);
      score += w;
      if (w >= DISTINCTIVE_WEIGHT) sharedDistinctive = true;
    } else {
      accountOnly.add(t);
      score -= ACCOUNT_ONLY_PENALTY * w;
      if (w >= DISTINCTIVE_WEIGHT) accountOnlyDistinctive = true;
    }
  }
  for (const t of productTokens) {
    if (accountTokens.has(t)) continue;
    score -= PRODUCT_ONLY_PENALTY * weightOf(t, df);
  }
  return { product, score, shared, accountOnly, sharedDistinctive, accountOnlyDistinctive };
}

// ---------------------------------------------------------------------------
// "why" copy

/** Longest run of consecutive words from the raw name whose tokens are in `set`, original casing. */
function phraseFrom(rawName: unknown, set: Set<string>): string {
  let best: string[] = [];
  let run: string[] = [];
  for (const w of rawWords(rawName)) {
    if (set.has(w.toLowerCase())) {
      run.push(w);
      if (run.length > best.length) best = run.slice();
    } else {
      run = [];
    }
  }
  return best.join(' ');
}

function whyText(account: Account, s: Scored, confidence: CardMatch['confidence']): string {
  const matched = phraseFrom(account?.name, s.shared);
  const conflict = phraseFrom(account?.name, s.accountOnly);
  if (confidence === 'high') {
    return matched ? `Matched on "${matched}"` : `Matched on the ${account?.institution ?? 'issuer'} name`;
  }
  if (confidence === 'medium') {
    if (matched && conflict) {
      return `Closest match on "${matched}", but the name also says "${conflict}" — confirm this is the right card in that family`;
    }
    return matched ? `Partial match on "${matched}" — confirm before using` : 'Plausible match on the issuer only — confirm before using';
  }
  return matched ? `Weak match on "${matched}" — pick manually if this is wrong` : 'No clear match in the name — pick manually';
}

// ---------------------------------------------------------------------------
// Public API

/**
 * True when the account label is a generic issuer name that identifies no
 * product — "Ultimate Rewards", "Membership Rewards", "Credit Card", "Visa".
 * Callers should ask the user which card it is instead of guessing.
 */
export function isAmbiguousName(account: Account): boolean {
  const tokens = tokenize(account?.name, account?.institution);
  if (tokens.length === 0) return true; // "Credit Card", "Card", "" — nothing left after stopwords
  return tokens.every((t) => AMBIGUOUS_ONLY.has(t));
}

/**
 * Best CardProduct for a linked account, or null when nothing is defensible.
 *
 * `products` is injectable for tests; production callers pass nothing and get
 * the live CARD_PRODUCTS, so the matcher sharpens as the database grows.
 */
export function matchProduct(account: Account, products: readonly CardProduct[] = CARD_PRODUCTS): CardMatch | null {
  if (!account || typeof account !== 'object') return null;
  if (account.type !== 'credit') return null; // checking/savings are not card products
  if (isAmbiguousName(account)) return null; // explicit: never guess from "Ultimate Rewards"

  const { products: list, tokens: productTokens, df, issuers } = buildIndex(products);
  const accountTokens = tokenSet(account.name, account.institution);
  if (accountTokens.size === 0) return null;
  const accountIssuer = issuerKeys(account.institution);

  let best: Scored | null = null;
  let runnerUp = -Infinity;
  for (let i = 0; i < list.length; i++) {
    if (!issuerCompatible(accountIssuer, issuers[i])) continue; // hard gate
    const s = scoreProduct(accountTokens, productTokens[i], df, list[i]);
    if (!best || s.score > best.score) {
      if (best) runnerUp = Math.max(runnerUp, best.score);
      best = s;
    } else if (s.score > runnerUp) {
      runnerUp = s.score;
    }
  }
  if (!best || best.score < 2.5) return null;

  // Two products this close means the name does not actually separate them.
  const separated = best.score - runnerUp >= 1.5;
  const issuerAgrees = accountIssuer.size > 0 && issuerCompatible(accountIssuer, issuerKeys(best.product.issuer));

  let confidence: CardMatch['confidence'];
  if (best.score >= 6 && best.sharedDistinctive && !best.accountOnlyDistinctive && issuerAgrees && separated) {
    confidence = 'high';
  } else if (best.score >= 7 && best.sharedDistinctive) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return { productId: best.product.id, confidence, why: whyText(account, best, confidence) };
}

// ---------------------------------------------------------------------------
// Pick-lists for ambiguous accounts

const HINT_STOP = new Set(['airlines', 'airline', 'air', 'lines', 'group', 'international']);

interface ProgramHint {
  id: string;
  kind: string;
  tokens: Set<string>;
}

let programHintCache: ProgramHint[] | null = null;

function programHints(): ProgramHint[] {
  if (programHintCache) return programHintCache;
  programHintCache = LOYALTY_PROGRAMS.map((p) => ({
    id: p.id,
    kind: p.kind,
    tokens: new Set(tokenize(p.name).filter((t) => !GENERIC.has(t) && !HINT_STOP.has(t))),
  }));
  return programHintCache;
}

/** Bigger limits go to premium cards; treat "no limit reported" as unknown. */
function limitTier(limit: number | undefined): number {
  if (typeof limit !== 'number' || !isFinite(limit) || limit <= 0) return 2; // unknown: sit in the middle
  if (limit >= 15000) return 3;
  if (limit >= 7000) return 2;
  return 1;
}

function feeTier(fee: number | undefined): number {
  const f = typeof fee === 'number' && isFinite(fee) ? fee : 0;
  if (f >= 300) return 3;
  if (f >= 90) return 2;
  return 1;
}

/**
 * Plausible products for an account whose name doesn't name one — the pick-list
 * the UI shows instead of a 30-item dropdown. Ranked by issuer (a hard filter),
 * then by how well the credit limit lines up with the card's annual-fee tier,
 * then by any loyalty program the label does name ("Ultimate Rewards" -> the UR
 * cards), then by the curated order in CARD_PRODUCTS.
 */
export function suggestionsFor(
  account: Account,
  limit = 5,
  products: readonly CardProduct[] = CARD_PRODUCTS,
): CardProduct[] {
  const n = Math.max(0, Math.floor(Number(limit) || 0));
  if (n === 0) return [];
  const { products: list, issuers, tokens: productTokens, df } = buildIndex(products);
  if (list.length === 0) return [];

  const accountIssuer = issuerKeys(account?.institution);
  const candidates: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (issuerCompatible(accountIssuer, issuers[i])) candidates.push(i);
  }
  const pool = candidates.length > 0 ? candidates : list.map((_, i) => i);

  const accountTokens = tokenSet(account?.name, account?.institution);
  const hinted = new Set<string>();
  let bankHint = false;
  for (const h of programHints()) {
    for (const t of h.tokens) {
      if (accountTokens.has(t)) {
        hinted.add(h.id);
        if (h.kind === 'bank') bankHint = true;
        break;
      }
    }
  }

  const lt = limitTier(account?.creditLimit);
  const scored = pool.map((i) => {
    const p = list[i];
    let s = 10 - 3 * Math.abs(lt - feeTier(p.annualFee));
    if (p.programId && hinted.has(p.programId)) s += 8;
    // Cash-back cards carry no programId but still earn into the issuer's bank
    // program in real life (a Freedom's points pool with a Sapphire's), so a
    // bank-program hint lifts them too, just less.
    else if (!p.programId && bankHint) s += 3;
    // Any real name signal still counts, so this stays useful for non-ambiguous accounts.
    s += 0.5 * Math.max(0, scoreProduct(accountTokens, productTokens[i], df, p).score);
    s -= i * 0.01; // stable tiebreak: curated order in CARD_PRODUCTS
    return { p, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, n).map((x) => x.p);
}
