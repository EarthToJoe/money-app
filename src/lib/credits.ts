import type { Account, CardCredit, CardProduct, CreditPeriod, CreditUsage, Transaction } from '../types';
import { productById } from '../data/cards';
import { fmtDateLong } from './format';

// ---------------------------------------------------------------------------
// Card-credits engine.
//
// A credit (Uber Cash, hotel credit, airline fee credit...) resets on a
// schedule. For each credit on each owned card we work out:
//   - which period `today` falls in (periodKey — also the store key for usage)
//   - when that period ends and how many days are left
//   - how much looks used: recorded usage wins; otherwise transactions on the
//     same account that match the credit's regex, capped at the face amount.
//
// Period keys:
//   monthly     '2026-08'         calendar month
//   quarterly   '2026-Q3'         calendar quarter
//   semiannual  '2026-H2'         Jan–Jun / Jul–Dec
//   annual      '2026'            calendar year
//   anniversary 'A2026-03-10'     card year starting on the most recent
//                                 anniversary of Account.openedAt. Without an
//                                 openedAt the credit falls back to 'annual'.
//
// daysLeft is inclusive of today: on the period's last day it reads 1, so the
// UI never shows "0 days left" for a credit that is still usable. It is 0 only
// when the period has already ended (which can't happen for a period derived
// from `today`, but periodInfo callers may pass stale keys).

export interface CreditStatus {
  account: Account;
  product: CardProduct;
  credit: CardCredit;
  periodKey: string;
  periodLabel: string; // 'August 2026', 'Q3 2026', 'Jul–Dec 2026', '2026', 'Card year from Mar 10, 2026'
  periodEnds: string; // 'YYYY-MM-DD'
  daysLeft: number;
  /** sum of matching transactions in the period (0 if no matchPattern) */
  autoDetected: number;
  /** manual/confirmed usage from the store (undefined if none recorded) */
  recorded?: number;
  /** what we believe was used: recorded if present, else autoDetected */
  used: number;
  remaining: number;
}

// ------------------------------------------------------------ date utils ---

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

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

function daysInMonth(y: number, m: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Whole days from a to b (b − a), DST-safe. */
function dayDiff(a: string, b: string): number {
  const A = parseIso(a);
  const B = parseIso(b);
  const ms = Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d);
  return Math.round(ms / 86_400_000);
}

function addDays(iso: string, n: number): string {
  const { y, m, d } = parseIso(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Local "today" as 'YYYY-MM-DD'. */
export function todayIso(now: Date = new Date()): string {
  return isoOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** The anniversary of `openedAt` falling in calendar year `y` (Feb 29 clamps to Feb 28). */
function anniversaryIn(openedAt: string, y: number): string {
  const { m, d } = parseIso(openedAt);
  return isoOf(y, m, Math.min(d, daysInMonth(y, m)));
}

// --------------------------------------------------------------- periods ---

/** Period key for a credit period containing `date`. Anniversary periods need openedAt (fallback: calendar year). */
export function periodKeyFor(period: CreditPeriod, date: string, openedAt?: string): string {
  const { y, m } = parseIso(date);
  switch (period) {
    case 'monthly':
      return `${y}-${pad2(m)}`;
    case 'quarterly':
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case 'semiannual':
      return `${y}-H${m <= 6 ? 1 : 2}`;
    case 'annual':
      return String(y);
    case 'anniversary': {
      if (!openedAt) return String(y);
      // Card not open yet: treat the first card year as the period.
      if (date < openedAt) return `A${openedAt}`;
      const thisYear = anniversaryIn(openedAt, y);
      return `A${date >= thisYear ? thisYear : anniversaryIn(openedAt, y - 1)}`;
    }
  }
}

interface PeriodRange {
  start: string;
  ends: string;
  label: string;
}

/**
 * Start, end and label for a period key. Reads the key's shape rather than
 * trusting `period` blindly, so an anniversary credit whose key fell back to a
 * calendar year ('2026') still resolves correctly.
 */
function periodRange(period: CreditPeriod, periodKey: string, openedAt?: string): PeriodRange {
  let m: RegExpMatchArray | null;

  if ((m = periodKey.match(/^A(\d{4})-(\d{2})-(\d{2})$/))) {
    const start = `${m[1]}-${m[2]}-${m[3]}`;
    const y = Number(m[1]);
    // Next anniversary uses openedAt's month/day when known (handles Feb 29), else the key's.
    const next = anniversaryIn(openedAt ?? start, y + 1);
    return { start, ends: addDays(next, -1), label: `Card year from ${fmtDateLong(start)}` };
  }
  if ((m = periodKey.match(/^(\d{4})-Q([1-4])$/))) {
    const y = Number(m[1]);
    const q = Number(m[2]);
    const firstMonth = (q - 1) * 3 + 1;
    const lastMonth = firstMonth + 2;
    return {
      start: isoOf(y, firstMonth, 1),
      ends: isoOf(y, lastMonth, daysInMonth(y, lastMonth)),
      label: `Q${q} ${y}`,
    };
  }
  if ((m = periodKey.match(/^(\d{4})-H([12])$/))) {
    const y = Number(m[1]);
    const h = Number(m[2]);
    return h === 1
      ? { start: isoOf(y, 1, 1), ends: isoOf(y, 6, 30), label: `Jan–Jun ${y}` }
      : { start: isoOf(y, 7, 1), ends: isoOf(y, 12, 31), label: `Jul–Dec ${y}` };
  }
  if ((m = periodKey.match(/^(\d{4})-(\d{2})$/))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    return {
      start: isoOf(y, mo, 1),
      ends: isoOf(y, mo, daysInMonth(y, mo)),
      label: `${MONTHS_LONG[mo - 1] ?? periodKey} ${y}`,
    };
  }
  if ((m = periodKey.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    return { start: isoOf(y, 1, 1), ends: isoOf(y, 12, 31), label: String(y) };
  }

  // Unknown key shape — last resort: the period containing today for this period type.
  const fallbackKey = periodKeyFor(period, todayIso(), openedAt);
  return fallbackKey === periodKey
    ? { start: periodKey, ends: periodKey, label: periodKey }
    : periodRange(period, fallbackKey, openedAt);
}

/** Human label + end date for a period key. */
export function periodInfo(period: CreditPeriod, periodKey: string, openedAt?: string): { label: string; ends: string } {
  const { label, ends } = periodRange(period, periodKey, openedAt);
  return { label, ends };
}

// --------------------------------------------------------------- engine ---

function compilePattern(source: string | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Status of every credit on one account for the period containing `today`. */
export function creditsForAccount(
  account: Account,
  usages: CreditUsage[],
  txns: Transaction[],
  today?: string,
): CreditStatus[] {
  if (!account.productId) return [];
  const product = productById(account.productId);
  if (!product?.credits?.length) return [];

  const now = today ?? todayIso();
  const accountTxns = txns.filter((t) => t.accountId === account.id && t.amount > 0);

  return product.credits.map((credit) => {
    const periodKey = periodKeyFor(credit.period, now, account.openedAt);
    const { start, ends, label } = periodRange(credit.period, periodKey, account.openedAt);

    let autoDetected = 0;
    const re = compilePattern(credit.matchPattern);
    if (re) {
      for (const t of accountTxns) {
        if (t.date < start || t.date > ends) continue;
        if (re.test(`${t.merchant} ${t.rawDescription}`)) autoDetected += t.amount;
      }
      autoDetected = round2(Math.min(credit.amount, autoDetected));
    }

    const recorded = usages.find(
      (u) => u.accountId === account.id && u.creditId === credit.id && u.periodKey === periodKey,
    )?.used;

    const used = round2(recorded ?? autoDetected);
    const remaining = round2(Math.max(0, credit.amount - used));
    const daysLeft = Math.max(0, dayDiff(now, ends) + 1);

    return {
      account,
      product,
      credit,
      periodKey,
      periodLabel: label,
      periodEnds: ends,
      daysLeft,
      autoDetected,
      recorded,
      used,
      remaining,
    };
  });
}

/** All credits across accounts; sorted by urgency (remaining > 0, fewest days left, then largest remaining). */
export function creditsAll(
  accounts: Account[],
  usages: CreditUsage[],
  txns: Transaction[],
  today?: string,
): CreditStatus[] {
  const now = today ?? todayIso();
  const all = accounts.flatMap((a) => creditsForAccount(a, usages, txns, now));
  return all.sort((a, b) => {
    const aOpen = a.remaining > 0 ? 0 : 1;
    const bOpen = b.remaining > 0 ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    if (a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft;
    return b.remaining - a.remaining;
  });
}

const PERIODS_PER_YEAR: Record<CreditPeriod, number> = {
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
  anniversary: 1,
};

/** Annualized face value of a product's credits, in dollars. */
export function annualCreditValue(product: CardProduct): number {
  if (!product.credits?.length) return 0;
  return round2(product.credits.reduce((sum, c) => sum + c.amount * PERIODS_PER_YEAR[c.period], 0));
}
