import type { Account, BonusTracking, CardProduct, Transaction } from '../types';
import { productById } from '../data/cards';
import { isSpending } from './analytics';

// Welcome-bonus engine. Pure functions over the store's accounts + transactions.
// Dates are 'YYYY-MM-DD' strings throughout; day math is done in UTC so DST
// never shifts a deadline by an hour.

export type BonusStatus = 'in-progress' | 'earned' | 'missed' | 'abandoned';

export interface BonusProgress {
  account: Account;
  product: CardProduct;
  tracking: BonusTracking;
  spent: number; // eligible spend since startDate (spending only, no transfers/fees)
  remaining: number; // max(0, minSpend − spent)
  daysLeft: number; // 0 when past deadline
  status: BonusStatus;
  /** value of the bonus in cents (points × product.pointValueCents) */
  valueCents: number;
  /** extra cents of value per $1 spent while the bonus is in progress (valueCents / minSpend) */
  boostPerDollarCents: number;
  /** spend per day needed to finish on time (0 when not applicable) */
  neededPerDay: number;
}

// ---------------------------------------------------------------------------
// Date helpers (local, not exported — other modules have their own).

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseIso(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

function toIso(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function daysInMonth(y: number, m: number): number {
  // Day 0 of the next month = last day of this month (UTC, no DST drift).
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Whole days from `a` to `b` (positive when b is later). */
function daysBetween(a: string, b: string): number {
  const pa = parseIso(a);
  const pb = parseIso(b);
  const ms = Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d);
  return Math.round(ms / 86_400_000);
}

/** `iso` + `months`, keeping the day-of-month and clamping to the target month's length. */
export function addMonthsClamped(iso: string, months: number): string {
  const { y, m, d } = parseIso(iso);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return toIso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

// ---------------------------------------------------------------------------

/** Default tracking for a card from its product's signupBonus and openedAt. Null if the product has no bonus. */
export function defaultBonusTracking(product: CardProduct, openedAt: string): BonusTracking | null {
  const sb = product.signupBonus;
  if (!sb || !openedAt) return null;
  return {
    points: sb.points,
    minSpend: sb.minSpend,
    startDate: openedAt,
    deadline: addMonthsClamped(openedAt, sb.months),
  };
}

/** Progress for one account, or null if it has no tracking / product. */
export function bonusProgressFor(account: Account, txns: Transaction[], today?: string): BonusProgress | null {
  if (account.type !== 'credit' || !account.bonus || !account.productId) return null;
  const product = productById(account.productId);
  if (!product) return null;

  const tracking = account.bonus;
  const now = today ?? todayIso();

  let spent = 0;
  for (const t of txns) {
    if (t.accountId !== account.id || t.amount <= 0 || !isSpending(t)) continue;
    if (t.date < tracking.startDate || t.date > tracking.deadline) continue;
    spent += t.amount;
  }
  spent = Math.round(spent * 100) / 100;

  const remaining = Math.max(0, Math.round((tracking.minSpend - spent) * 100) / 100);
  const daysLeft = Math.max(0, daysBetween(now, tracking.deadline));

  let status: BonusStatus;
  if (tracking.status === 'earned') status = 'earned';
  else if (tracking.status === 'abandoned') status = 'abandoned';
  else if (spent >= tracking.minSpend) status = 'earned';
  else if (now > tracking.deadline) status = 'missed';
  else status = 'in-progress';

  const valueCents = Math.round(tracking.points * product.pointValueCents);
  const boostPerDollarCents = tracking.minSpend > 0 ? valueCents / tracking.minSpend : 0;
  const neededPerDay = status === 'in-progress' ? remaining / Math.max(1, daysLeft) : 0;

  return {
    account,
    product,
    tracking,
    spent,
    remaining,
    daysLeft,
    status,
    valueCents,
    boostPerDollarCents,
    neededPerDay,
  };
}

const STATUS_ORDER: Record<BonusStatus, number> = {
  'in-progress': 0,
  earned: 1,
  missed: 2,
  abandoned: 3,
};

/** Progress for every credit account with a `bonus` set. Sorted: in-progress first (least days left), then others. */
export function bonusProgressAll(accounts: Account[], txns: Transaction[], today?: string): BonusProgress[] {
  const now = today ?? todayIso();
  const out: BonusProgress[] = [];
  for (const a of accounts) {
    const p = bonusProgressFor(a, txns, now);
    if (p) out.push(p);
  }
  return out.sort((a, b) => {
    const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (so !== 0) return so;
    if (a.status === 'in-progress' && a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft;
    return a.account.name.localeCompare(b.account.name);
  });
}
