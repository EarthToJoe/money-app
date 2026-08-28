import type { CardProduct } from '../../types';
import { programById } from '../../data/programs';
import { fmtUsdWhole } from '../../lib/format';
import type { BonusStatus } from '../../lib/bonus';

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Gradient for manual cards with no linked product. */
export const FALLBACK_GRADIENT: [string, string] = ['#52514e', '#898781'];

/** Badge class for a "resets in N days" countdown. */
export function daysBadgeClass(daysLeft: number): string {
  if (daysLeft <= 3) return 'badge badge-bad';
  if (daysLeft <= 10) return 'badge badge-warn';
  return 'badge badge-neutral';
}

export function resetsLabel(daysLeft: number): string {
  if (daysLeft <= 0) return 'resets today';
  if (daysLeft === 1) return 'resets tomorrow';
  return `resets in ${daysLeft} days`;
}

export function daysLeftLabel(daysLeft: number): string {
  if (daysLeft <= 0) return 'due today';
  if (daysLeft === 1) return '1 day left';
  return `${daysLeft} days left`;
}

/** Short loyalty-program label for a product: "UR", "MR", "Cash back", or a sensible fallback. */
export function programLabel(product: CardProduct): string {
  if (product.currency === 'cashback') return 'Cash back';
  if (product.programId) {
    const p = programById(product.programId);
    if (p) return p.short;
  }
  return product.currency === 'miles' ? 'Miles' : 'Points';
}

export function feeLabel(annualFee: number): string {
  return annualFee === 0 ? 'No annual fee' : `${fmtUsdWhole(annualFee)} annual fee`;
}

export const BONUS_STATUS_LABEL: Record<BonusStatus, string> = {
  'in-progress': 'In progress',
  earned: 'Earned',
  missed: 'Missed',
  abandoned: 'Not pursuing',
};

export const BONUS_STATUS_BADGE: Record<BonusStatus, string> = {
  'in-progress': 'badge badge-neutral',
  earned: 'badge badge-good',
  missed: 'badge badge-bad',
  abandoned: 'badge badge-neutral',
};

/** "60,000 pts" / "60,000 miles" / "$200 cash back" */
export function bonusPointsLabel(product: CardProduct, points: number): string {
  if (product.currency === 'cashback') return `${fmtUsdWhole(points / 100)} cash back`;
  const unit = product.currency === 'miles' ? 'miles' : 'pts';
  return `${new Intl.NumberFormat('en-US').format(points)} ${unit}`;
}
