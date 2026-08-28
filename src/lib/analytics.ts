import type { Budget, CategoryId, Transaction } from '../types';

// ---------------------------------------------------------------------------
// Month keys. A month key is 'YYYY-MM'. All aggregation is keyed on these.

export function monthKeyOf(dateIso: string): string {
  return dateIso.slice(0, 7);
}

export function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function addMonths(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** '2026-08' → 'Aug 2026' */
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** '2026-08' → 'Aug' */
export function monthLabelShort(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
}

/** Last n month keys ending at endKey (inclusive), oldest first. */
export function lastMonthKeys(n: number, endKey = currentMonthKey()): string[] {
  return Array.from({ length: n }, (_, i) => addMonths(endKey, i - (n - 1)));
}

// ---------------------------------------------------------------------------
// Spending selectors. "Spending" = positive amounts, excluding transfers and
// income (refunds show as negative amounts within a category and net out).

export function isSpending(t: Transaction): boolean {
  return t.category !== 'transfer' && t.category !== 'income';
}

export function txnsInMonth(txns: Transaction[], key: string): Transaction[] {
  return txns.filter((t) => monthKeyOf(t.date) === key);
}

export function totalSpending(txns: Transaction[], key: string): number {
  return txnsInMonth(txns, key)
    .filter(isSpending)
    .reduce((sum, t) => sum + t.amount, 0);
}

export function totalIncome(txns: Transaction[], key: string): number {
  return txnsInMonth(txns, key)
    .filter((t) => t.category === 'income')
    .reduce((sum, t) => sum + -t.amount, 0);
}

export interface CategoryTotal {
  category: CategoryId;
  total: number;
}

/** Spending by category for one month, sorted descending. */
export function spendingByCategory(txns: Transaction[], key: string): CategoryTotal[] {
  const totals = new Map<CategoryId, number>();
  for (const t of txnsInMonth(txns, key)) {
    if (!isSpending(t)) continue;
    totals.set(t.category, (totals.get(t.category) ?? 0) + t.amount);
  }
  return [...totals.entries()]
    .map(([category, total]) => ({ category, total }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);
}

export interface MonthPoint {
  month: string; // month key
  total: number;
}

/** Total spending per month for the last n months, oldest first. */
export function monthlySpendingSeries(
  txns: Transaction[],
  n: number,
  endKey = currentMonthKey(),
): MonthPoint[] {
  return lastMonthKeys(n, endKey).map((month) => ({ month, total: totalSpending(txns, month) }));
}

/**
 * Per-month totals for each of the given categories, oldest first.
 * Result rows look like { month: '2026-03', dining: 412.5, groceries: 618.2 }.
 */
export function monthlyCategorySeries(
  txns: Transaction[],
  n: number,
  categories: CategoryId[],
  endKey = currentMonthKey(),
): Array<Record<string, number | string>> {
  return lastMonthKeys(n, endKey).map((month) => {
    const row: Record<string, number | string> = { month };
    const inMonth = txnsInMonth(txns, month).filter(isSpending);
    for (const cat of categories) {
      row[cat] = inMonth.filter((t) => t.category === cat).reduce((s, t) => s + t.amount, 0);
    }
    return row;
  });
}

export interface MerchantTotal {
  merchant: string;
  total: number;
  count: number;
  category: CategoryId;
}

export function topMerchants(txns: Transaction[], key: string, n = 8): MerchantTotal[] {
  const byMerchant = new Map<string, MerchantTotal>();
  for (const t of txnsInMonth(txns, key)) {
    if (!isSpending(t) || t.amount <= 0) continue;
    const cur = byMerchant.get(t.merchant);
    if (cur) {
      cur.total += t.amount;
      cur.count += 1;
    } else {
      byMerchant.set(t.merchant, {
        merchant: t.merchant,
        total: t.amount,
        count: 1,
        category: t.category,
      });
    }
  }
  return [...byMerchant.values()].sort((a, b) => b.total - a.total).slice(0, n);
}

/** Average monthly spend per category over the trailing n FULL months (excludes the current partial month). */
export function avgMonthlySpendByCategory(
  txns: Transaction[],
  n = 3,
): Map<CategoryId, number> {
  const endKey = addMonths(currentMonthKey(), -1);
  const keys = lastMonthKeys(n, endKey);
  const totals = new Map<CategoryId, number>();
  for (const key of keys) {
    for (const { category, total } of spendingByCategory(txns, key)) {
      totals.set(category, (totals.get(category) ?? 0) + total);
    }
  }
  const avg = new Map<CategoryId, number>();
  for (const [cat, total] of totals) avg.set(cat, total / n);
  return avg;
}

// ---------------------------------------------------------------------------
// Budgets

export interface BudgetProgress {
  categoryId: CategoryId;
  limit: number;
  spent: number;
  /** spent / limit, uncapped (1.2 = 20% over) */
  ratio: number;
}

export function budgetProgress(
  txns: Transaction[],
  budgets: Budget[],
  key = currentMonthKey(),
): BudgetProgress[] {
  const spentByCat = new Map(spendingByCategory(txns, key).map((c) => [c.category, c.total]));
  return budgets
    .map((b) => {
      const spent = spentByCat.get(b.categoryId) ?? 0;
      return {
        categoryId: b.categoryId,
        limit: b.monthlyLimit,
        spent,
        ratio: b.monthlyLimit > 0 ? spent / b.monthlyLimit : 0,
      };
    })
    .sort((a, b) => b.ratio - a.ratio);
}

/** Fraction of the current month elapsed (0..1) — for "pace" indicators. */
export function monthElapsedFraction(now = new Date()): number {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.min(1, now.getDate() / daysInMonth);
}
