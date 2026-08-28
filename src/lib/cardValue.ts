import type {
  Account,
  CardCredit,
  CardProduct,
  CreditPeriod,
  CreditUsage,
  Settings,
  Transaction,
} from '../types';
import { productById } from '../data/cards';
import { programById } from '../data/programs';
import { isSpending } from './analytics';
import { addMonthsClamped, bonusProgressFor } from './bonus';
import { periodInfo, periodKeyFor, todayIso } from './credits';
import { computeEarnings } from './rewards';

// ---------------------------------------------------------------------------
// Per-card value engine — "what did this card actually give me?"
//
// Deliberately NOT a verdict. This module never asks whether a card is
// "justified"; it adds up what the card returned over a window and what it
// cost, and hands both numbers to the UI.
//
// The fee side is the part that has to stay honest. A cardholder can pay
// something other than the published fee — an SCRA military waiver, a
// retention offer, a first-year-free promo — so every fee figure here comes
// from effectiveAnnualFee(), and isFeeWaived() tells the UI when a $0 needs
// the words "waived by the issuer" next to it rather than being shown bare.
//
// Worked example (Hilton Aspire, published fee $550, SCRA-waived, 12-month
// window): resort credit $200 semiannual → 2 periods → $400 available;
// flight credit $50 quarterly → 4 periods → $200; CLEAR $209 annual → 1
// period → $209. creditsAvailable = $809. If the two resort credits and one
// flight credit were used, creditsUsed = $450 and $359 was left on the table.
// feeCents = 0 with feeWaived = true, so netValue = rewards + $450 + bonus.

export interface CardValue {
  account: Account;
  product: CardProduct;
  /** 'YYYY-MM-DD' — start of the measured window (clamped to Account.openedAt). */
  windowStart: string;
  /** 'YYYY-MM-DD' — end of the measured window (usually today). */
  windowEnd: string;
  /** Length of the window in months; fractional for a card opened mid-window. */
  months: number;
  /** Eligible card spend in the window, in dollars. */
  spend: number;
  /** Points/miles earned in the window (cashback cards: cents of cash back). */
  pointsEarned: number;
  /** Value of those points at the product's planning value, in cents. */
  rewardValueCents: number;
  /** Statement credits detected or recorded as used, in cents. */
  creditsUsedCents: number;
  /** Face value of every credit period that fell in the window, in cents. */
  creditsAvailableCents: number;
  /** Welcome bonus, counted only once it is earned. */
  bonusValueCents: number;
  /** What the cardholder actually paid, pro-rated to the window. */
  feeCents: number;
  /** True when the effective fee is $0 but the product publishes a real fee. */
  feeWaived: boolean;
  /** rewards + credits used + bonus − fee. */
  netValueCents: number;
  /** 'Membership Rewards points', 'Hilton Honors points', 'cash back'. */
  currencyLabel: string;
}

export interface CardValueContext {
  transactions: Transaction[];
  creditUsages: CreditUsage[];
  settings: Settings;
  /** 'YYYY-MM-DD'; defaults to today. */
  today?: string;
  /** Window length in months; defaults to 12. */
  months?: number;
}

export interface PortfolioValue {
  rewardValueCents: number;
  creditsUsedCents: number;
  /** Credits that were on offer and went unused — the real loss when fees are waived. */
  creditsLeftOnTableCents: number;
  bonusValueCents: number;
  feeCents: number;
  netValueCents: number;
}

// ------------------------------------------------------------------- fees ---

/**
 * What this cardholder pays per year for this card, in dollars.
 * Precedence: per-card override → global waiver → the product's published fee.
 */
export function effectiveAnnualFee(
  product: CardProduct | undefined,
  account: Account | undefined,
  settings: Settings,
): number {
  const override = account?.annualFeeOverride;
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) return override;
  if (settings?.waiveAnnualFees) return 0;
  const published = product?.annualFee;
  return typeof published === 'number' && Number.isFinite(published) ? published : 0;
}

/**
 * True when the cardholder pays nothing for a card that does carry a fee —
 * the UI must say "waived", not show a bare $0 with no explanation.
 */
export function isFeeWaived(
  product: CardProduct | undefined,
  account: Account | undefined,
  settings: Settings,
): boolean {
  const published = product?.annualFee ?? 0;
  return published > 0 && effectiveAnnualFee(product, account, settings) === 0;
}

// ------------------------------------------------------------- date utils ---
// Local copies: credits.ts keeps its own private versions and bonus.ts only
// exports addMonthsClamped. All arithmetic is UTC so DST never shifts a day.

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function parseIso(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m: m || 1, d: d || 1 };
}

function dayDiff(a: string, b: string): number {
  const A = parseIso(a);
  const B = parseIso(b);
  return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / 86_400_000);
}

function addDays(iso: string, n: number): string {
  const { y, m, d } = parseIso(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Calendar months from `start` to `end`, with a fractional tail. 0 when end <= start. */
function monthsBetween(start: string, end: string): number {
  if (end <= start) return 0;
  let whole = 0;
  while (whole < 600 && addMonthsClamped(start, whole + 1) <= end) whole++;
  const anchor = addMonthsClamped(start, whole);
  const next = addMonthsClamped(start, whole + 1);
  const span = dayDiff(anchor, next);
  const frac = span > 0 ? Math.max(0, dayDiff(anchor, end)) / span : 0;
  return whole + frac;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- periods ---

interface PeriodSpan {
  key: string;
  start: string;
  ends: string;
}

/**
 * First day of a period, read back from its key (shapes documented in
 * credits.ts). credits.ts exports the END of a period but not its start, and
 * the start is what decides whether the period belongs to this window.
 */
function periodStartOfKey(key: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = key.match(/^A(\d{4}-\d{2}-\d{2})$/))) return m[1];
  if ((m = key.match(/^(\d{4})-Q([1-4])$/))) return isoOf(Number(m[1]), (Number(m[2]) - 1) * 3 + 1, 1);
  if ((m = key.match(/^(\d{4})-H([12])$/))) return isoOf(Number(m[1]), m[2] === '1' ? 1 : 7, 1);
  if ((m = key.match(/^(\d{4})-(\d{2})$/))) return isoOf(Number(m[1]), Number(m[2]), 1);
  if ((m = key.match(/^(\d{4})$/))) return isoOf(Number(m[1]), 1, 1);
  return null;
}

/**
 * Every period of `period` that STARTS inside [windowStart, windowEnd).
 *
 * This is the fiddly bit: a monthly credit has twelve independent periods in a
 * year and each is separately used-or-not, while an annual credit has one. The
 * period straddling windowStart belongs to the previous window and is skipped,
 * which keeps a 12-month window at exactly 12 monthly / 4 quarterly / 2
 * semiannual / 1 annual period no matter which day of the month "today" is.
 */
function periodsStartingIn(
  period: CreditPeriod,
  windowStart: string,
  windowEnd: string,
  openedAt?: string,
): PeriodSpan[] {
  const out: PeriodSpan[] = [];
  if (windowEnd <= windowStart) return out;
  const seen = new Set<string>();
  let cursor = windowStart;
  for (let guard = 0; guard < 400 && cursor < windowEnd; guard++) {
    const key = periodKeyFor(period, cursor, openedAt);
    const { ends } = periodInfo(period, key, openedAt);
    const start = periodStartOfKey(key) ?? cursor;
    if (!seen.has(key) && start >= windowStart && start < windowEnd) {
      seen.add(key);
      out.push({ key, start, ends });
    }
    const next = addDays(ends, 1);
    if (next <= cursor) break; // malformed period — stop rather than spin
    cursor = next;
  }
  return out;
}

function compilePattern(source: string | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

/** Credit dollars matched by transactions inside one period, capped at the face amount. */
function autoDetectedInPeriod(credit: CardCredit, span: PeriodSpan, txns: Transaction[]): number {
  const re = compilePattern(credit.matchPattern);
  if (!re) return 0;
  let sum = 0;
  for (const t of txns) {
    if (t.date < span.start || t.date > span.ends) continue;
    if (re.test(`${t.merchant} ${t.rawDescription}`)) sum += t.amount;
  }
  return round2(Math.min(credit.amount, sum));
}

// --------------------------------------------------------- currency label ---

const PROGRAM_NAME_PREFIXES = ['American Express ', 'Chase '];

/** 'Membership Rewards points' / 'SkyMiles' / 'Hilton Honors points' / 'cash back'. */
function currencyLabelFor(product: CardProduct): string {
  if (product.currency === 'cashback') return 'cash back';
  const program = product.programId ? programById(product.programId) : undefined;
  if (!program) return product.currency === 'miles' ? 'miles' : 'points';

  let base = program.kind === 'airline' ? program.short : program.name;
  for (const prefix of PROGRAM_NAME_PREFIXES) {
    if (base.startsWith(prefix) && base.length > prefix.length) base = base.slice(prefix.length);
  }
  return /(points|miles)$/i.test(base) ? base : `${base} ${program.unit}`;
}

// ----------------------------------------------------------------- engine ---

/**
 * What one card returned over the window. Null when the account has no
 * resolvable product (nothing to value against).
 *
 * The window is the trailing `months` (default 12) ending at `today`, clamped
 * forward to Account.openedAt: a card opened last week is not charged with a
 * year of unused credits it never had. The flip side of that clamp plus the
 * "period must start inside the window" rule: a card opened today reports
 * zeros across the board — including a credit period already running when it
 * was approved — until its first full period begins. Undercounting a brand-new
 * card beats telling its holder they wasted $800 they never had the chance at.
 */
export function cardValue(account: Account, ctx: CardValueContext): CardValue | null {
  if (!account?.productId) return null;
  const product = productById(account.productId);
  if (!product) return null;

  const settings = ctx.settings ?? {};
  const today = ctx.today ?? todayIso();
  const requested = typeof ctx.months === 'number' && ctx.months > 0 ? ctx.months : 12;

  const windowEnd = today;
  let windowStart = addMonthsClamped(windowEnd, -requested);
  if (account.openedAt && account.openedAt > windowStart) {
    windowStart = account.openedAt > windowEnd ? windowEnd : account.openedAt;
  }
  const months = round2(monthsBetween(windowStart, windowEnd));

  const allTxns = ctx.transactions ?? [];
  const windowTxns = allTxns.filter(
    (t) => t.accountId === account.id && t.date >= windowStart && t.date <= windowEnd,
  );

  // Rewards — computeEarnings owns the multiplier and annual-cap math.
  let spend = 0;
  let pointsEarned = 0;
  let rewardValueCents = 0;
  for (const earning of computeEarnings(windowTxns, [account])) {
    pointsEarned += earning.points;
    rewardValueCents += earning.valueCents;
  }
  for (const t of windowTxns) {
    if (t.amount > 0 && isSpending(t)) spend += t.amount;
  }

  // Credits — every period independently, recorded usage beats auto-detection.
  const positiveTxns = windowTxns.filter((t) => t.amount > 0);
  const usages = (ctx.creditUsages ?? []).filter((u) => u.accountId === account.id);
  let creditsUsedCents = 0;
  let creditsAvailableCents = 0;
  for (const credit of product.credits ?? []) {
    const face = Math.max(0, credit.amount);
    for (const span of periodsStartingIn(credit.period, windowStart, windowEnd, account.openedAt)) {
      creditsAvailableCents += Math.round(face * 100);
      const recorded = usages.find((u) => u.creditId === credit.id && u.periodKey === span.key)?.used;
      const used = recorded ?? autoDetectedInPeriod(credit, span, positiveTxns);
      creditsUsedCents += Math.round(Math.min(face, Math.max(0, used)) * 100);
    }
  }

  // Welcome bonus — only once earned, and only if its window touches ours.
  let bonusValueCents = 0;
  const bonus = bonusProgressFor(account, allTxns, today);
  if (
    bonus &&
    bonus.status === 'earned' &&
    bonus.tracking.startDate <= windowEnd &&
    bonus.tracking.deadline >= windowStart
  ) {
    bonusValueCents = bonus.valueCents;
  }

  const feeCents = Math.round((effectiveAnnualFee(product, account, settings) * 100 * months) / 12);

  return {
    account,
    product,
    windowStart,
    windowEnd,
    months,
    spend: round2(spend),
    pointsEarned: round2(pointsEarned),
    rewardValueCents,
    creditsUsedCents,
    creditsAvailableCents,
    bonusValueCents,
    feeCents,
    feeWaived: isFeeWaived(product, account, settings),
    netValueCents: rewardValueCents + creditsUsedCents + bonusValueCents - feeCents,
    currencyLabel: currencyLabelFor(product),
  };
}

/** Value for every credit card with a resolvable product, best first. */
export function cardValueAll(accounts: Account[], ctx: CardValueContext): CardValue[] {
  const out: CardValue[] = [];
  for (const account of accounts ?? []) {
    if (account.type !== 'credit') continue;
    const value = cardValue(account, ctx);
    if (value) out.push(value);
  }
  return out.sort(
    (a, b) => b.netValueCents - a.netValueCents || a.account.name.localeCompare(b.account.name),
  );
}

/**
 * Wallet-wide totals. creditsLeftOnTable — credits that were on offer and went
 * unused — is the honest headline when fees are waived: it is the only place
 * this wallet actually loses money.
 */
export function portfolioValue(values: CardValue[]): PortfolioValue {
  const total: PortfolioValue = {
    rewardValueCents: 0,
    creditsUsedCents: 0,
    creditsLeftOnTableCents: 0,
    bonusValueCents: 0,
    feeCents: 0,
    netValueCents: 0,
  };
  let availableCents = 0;
  for (const v of values ?? []) {
    total.rewardValueCents += v.rewardValueCents;
    total.creditsUsedCents += v.creditsUsedCents;
    total.bonusValueCents += v.bonusValueCents;
    total.feeCents += v.feeCents;
    total.netValueCents += v.netValueCents;
    availableCents += v.creditsAvailableCents;
  }
  total.creditsLeftOnTableCents = Math.max(0, availableCents - total.creditsUsedCents);
  return total;
}
