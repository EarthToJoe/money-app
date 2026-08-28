import { useMemo, useState } from 'react';
import { useApp } from '../store';
import {
  addMonths,
  budgetProgress,
  currentMonthKey,
  isSpending,
  lastMonthKeys,
  monthElapsedFraction,
  monthLabel,
  monthLabelShort,
  txnsInMonth,
} from '../lib/analytics';
import { fmtPct, fmtUsd, fmtUsdWhole } from '../lib/format';
import { SPENDING_CATEGORY_IDS, categoryDef } from '../data/categories';
import type { CategoryId, Transaction } from '../types';
import BudgetRow from './budgets/BudgetRow';
import { BudgetBar } from './budgets/BudgetBar';
import AddBudgetModal, {
  estimateBasisText,
  oneOffLabel,
  oneOffTitle,
  roundUpTo25,
  type OneOffPurchase,
  type SpendEstimate,
} from './budgets/AddBudgetModal';

/** A category needs at least this much typical monthly spend to be suggested. */
const MEANINGFUL_MONTHLY_SPEND = 20;
/** Trailing FULL months the estimate looks at (the current month is partial). */
const LOOKBACK_MONTHS = 3;
/** Fewer months of data than this and a median is meaningless — use the mean. */
const MIN_MONTHS_FOR_MEDIAN = 3;
/** A one-off has to be at least this share of its month's category total... */
const ONE_OFF_SHARE = 0.4;
/** ...and this many times the median purchase in that category that month. */
const ONE_OFF_MEDIAN_MULTIPLE = 3;

// ---------------------------------------------------------------------------
// "Typical month" spend per category — the basis for every budget suggestion.
//
// A plain mean over the trailing months is trivially wrecked by one big
// purchase: a single $2,305 Bloomingdale's charge turned a ~$400/mo shopping
// habit into a suggested "$3,125/mo". A budget the user cannot hit is worse
// than no budget at all, so the estimate is outlier-robust in two ways:
//   1. inside each month, clear one-offs (a mattress, a flight) are dropped —
//      a purchase that is both >40% of the month's category total and >3x the
//      median purchase in it is not recurring spend;
//   2. across months, the MEDIAN monthly total is used, not the mean, so one
//      unusual month can't drag the suggestion up.
// Anything dropped is named in the UI rather than quietly disappearing.
// SpendEstimate / OneOffPurchase and the wording helpers live in
// ./budgets/AddBudgetModal, which prefills from the same estimate.

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

export function spendEstimatesByCategory(
  txns: Transaction[],
  n = LOOKBACK_MONTHS,
): Map<CategoryId, SpendEstimate> {
  // Trailing FULL months only — the month in progress would read as a dip.
  const keys = lastMonthKeys(n, addMonths(currentMonthKey(), -1));
  const months = keys
    .map((key) => {
      const byCat = new Map<CategoryId, Transaction[]>();
      for (const t of txnsInMonth(txns, key).filter(isSpending)) {
        const list = byCat.get(t.category);
        if (list) list.push(t);
        else byCat.set(t.category, [t]);
      }
      return { key, byCat };
    })
    // A month with no transactions at all is missing history, not a $0 month;
    // counting it as zero would halve every suggestion for a new user.
    .filter((m) => m.byCat.size > 0);

  const categories = new Set<CategoryId>();
  for (const m of months) for (const cat of m.byCat.keys()) categories.add(cat);

  const out = new Map<CategoryId, SpendEstimate>();
  for (const cat of categories) {
    const monthTotals: number[] = [];
    const excluded: OneOffPurchase[] = [];

    for (const m of months) {
      const list = m.byCat.get(cat) ?? [];
      // Refunds are negative amounts and net against the month, as everywhere else.
      const total = list.reduce((sum, t) => sum + t.amount, 0);
      if (total <= 0) {
        monthTotals.push(0);
        continue;
      }
      const purchases = list.filter((t) => t.amount > 0);
      const med = median(purchases.map((t) => t.amount));
      const oneOffs = purchases.filter(
        (t) => t.amount > total * ONE_OFF_SHARE && t.amount > med * ONE_OFF_MEDIAN_MULTIPLE,
      );
      for (const t of oneOffs) {
        excluded.push({ merchant: t.merchant, date: t.date, amount: t.amount });
      }
      const adjusted = total - oneOffs.reduce((sum, t) => sum + t.amount, 0);
      monthTotals.push(Math.max(0, adjusted));
    }

    const usedMean = monthTotals.length < MIN_MONTHS_FOR_MEDIAN;
    const typical = usedMean ? mean(monthTotals) : median(monthTotals);
    excluded.sort((a, b) => b.date.localeCompare(a.date));
    out.set(cat, {
      typical,
      suggested: roundUpTo25(typical),
      months: monthTotals.length,
      usedMean,
      excluded,
    });
  }
  return out;
}

interface Suggestion {
  categoryId: CategoryId;
  estimate: SpendEstimate;
}

function SuggestionsCard({
  suggestions,
  onSet,
}: {
  suggestions: Suggestion[];
  onSet: (categoryId: CategoryId, limit: number) => void;
}) {
  return (
    <div className="card">
      <div className="card-title">Suggested budgets</div>
      <p className="small muted" style={{ marginTop: -8, marginBottom: 6 }}>
        {suggestions.some((s) => s.estimate.usedMean)
          ? `Your biggest unbudgeted categories, from your recent monthly spending — with less than ${MIN_MONTHS_FOR_MEDIAN} months of history these are plain averages.`
          : `Your biggest unbudgeted categories, from a typical month of the last ${LOOKBACK_MONTHS} — the middle month, not the average, so one big purchase can't set your budget.`}
      </p>
      {suggestions.map((s, i) => {
        const def = categoryDef(s.categoryId);
        const { typical, suggested, excluded } = s.estimate;
        return (
          <div
            key={s.categoryId}
            className="spread"
            style={{
              padding: '11px 0',
              borderTop: i === 0 ? undefined : '1px solid var(--grid)',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
              <div className="row" style={{ gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: 17, lineHeight: 1 }}>{def.emoji}</span>
                <span style={{ fontWeight: 600 }}>{def.label}</span>
                <span className="small muted tnum" title={estimateBasisText(s.estimate)}>
                  {fmtUsd(typical)}/mo typical
                </span>
              </div>
              {excluded.length > 0 && (
                <span className="small muted" title={oneOffTitle(excluded)}>
                  {oneOffLabel(excluded.length)}
                </span>
              )}
            </div>
            <button className="btn" onClick={() => onSet(s.categoryId, suggested)}>
              Set {fmtUsdWhole(suggested)}/mo
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default function Budgets() {
  const transactions = useApp((s) => s.transactions);
  const budgets = useApp((s) => s.budgets);
  const setBudget = useApp((s) => s.setBudget);
  const removeBudget = useApp((s) => s.removeBudget);

  const nowKey = currentMonthKey();
  const monthKeys = useMemo(() => lastMonthKeys(6), []);
  const [month, setMonth] = useState(nowKey);
  const isCurrentMonth = month === nowKey;
  const elapsed = monthElapsedFraction();

  const [showAdd, setShowAdd] = useState(false);

  const progress = useMemo(
    () => budgetProgress(transactions, budgets, month),
    [transactions, budgets, month],
  );
  const estimates = useMemo(
    () => spendEstimatesByCategory(transactions, LOOKBACK_MONTHS),
    [transactions],
  );

  const availableCategories = useMemo(() => {
    const budgeted = new Set(budgets.map((b) => b.categoryId));
    return SPENDING_CATEGORY_IDS.filter((id) => !budgeted.has(id));
  }, [budgets]);

  const suggestions = useMemo<Suggestion[]>(() => {
    const rows: Suggestion[] = [];
    for (const id of availableCategories) {
      const estimate = estimates.get(id);
      if (!estimate || estimate.typical < MEANINGFUL_MONTHLY_SPEND) continue;
      rows.push({ categoryId: id, estimate });
    }
    return rows.sort((a, b) => b.estimate.typical - a.estimate.typical);
  }, [availableCategories, estimates]);
  const showSuggestions = suggestions.length >= 3;
  const topSuggestions = suggestions.slice(0, 3);

  const totalBudgeted = progress.reduce((sum, p) => sum + p.limit, 0);
  const totalSpent = progress.reduce((sum, p) => sum + p.spent, 0);
  const spentFrac = totalBudgeted > 0 ? totalSpent / totalBudgeted : 0;
  const totalRemaining = totalBudgeted - totalSpent;
  const overCount = progress.filter((p) => p.ratio > 1).length;

  const paceBadge =
    spentFrac > 1
      ? { cls: 'badge-bad', label: 'Over budget' }
      : spentFrac - elapsed > 0.1
        ? { cls: 'badge-warn', label: 'Ahead of pace' }
        : { cls: 'badge-good', label: 'On pace' };

  const hasBudgets = budgets.length > 0;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Budgets</h1>
          <p className="page-subtitle">Monthly limits for the categories you care about.</p>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="segmented" role="tablist" aria-label="Month">
            {monthKeys.map((key) => (
              <button
                key={key}
                className={key === month ? 'active' : ''}
                onClick={() => setMonth(key)}
                title={monthLabel(key)}
              >
                {monthLabelShort(key)}
              </button>
            ))}
          </div>
          <button
            className="btn btn-primary"
            onClick={() => setShowAdd(true)}
            disabled={availableCategories.length === 0}
            title={
              availableCategories.length === 0
                ? 'Every spending category already has a budget'
                : undefined
            }
          >
            + Add budget
          </button>
        </div>
      </div>

      {hasBudgets ? (
        <>
          {/* Summary */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div className="stat">
                <div className="stat-label">
                  {isCurrentMonth ? 'Spent this month' : `Spent in ${monthLabel(month)}`}
                </div>
                <div className="stat-value tnum">
                  {fmtUsdWhole(totalSpent)}{' '}
                  <span className="muted" style={{ fontSize: 'var(--fs-xl)', fontWeight: 600 }}>
                    of {fmtUsdWhole(totalBudgeted)} budgeted
                  </span>
                </div>
              </div>
              {isCurrentMonth ? (
                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <span className="small muted">
                    {fmtPct(elapsed)} through the month, {fmtPct(spentFrac)} of budget used
                  </span>
                  <span className={`badge ${paceBadge.cls}`}>{paceBadge.label}</span>
                </div>
              ) : (
                <span className="small muted">{fmtPct(spentFrac)} of budget used</span>
              )}
            </div>
            <div style={{ marginTop: 14 }}>
              <BudgetBar
                ratio={spentFrac}
                color="var(--accent)"
                paceFraction={isCurrentMonth ? elapsed : undefined}
              />
            </div>
            <div className="spread" style={{ marginTop: 8 }}>
              {totalRemaining >= 0 ? (
                <span className="small muted tnum">{fmtUsd(totalRemaining)} left to spend</span>
              ) : (
                <span
                  className="small tnum"
                  style={{ color: 'var(--critical)', fontWeight: 600 }}
                >
                  {fmtUsd(-totalRemaining)} over budget
                </span>
              )}
              {overCount > 0 ? (
                <span className="small" style={{ color: 'var(--critical)', fontWeight: 600 }}>
                  {overCount} of {progress.length} {overCount === 1 ? 'category' : 'categories'}{' '}
                  over limit
                </span>
              ) : (
                <span className="small muted">
                  {progress.length} {progress.length === 1 ? 'budget' : 'budgets'}
                </span>
              )}
            </div>
          </div>

          {/* Budget list */}
          <div className="card" style={{ marginBottom: 16 }}>
            {progress.map((p, i) => (
              <BudgetRow
                key={p.categoryId}
                progress={p}
                paceFraction={isCurrentMonth ? elapsed : undefined}
                onSaveLimit={setBudget}
                onRemove={removeBudget}
                style={{
                  paddingTop: i === 0 ? 2 : 14,
                  paddingBottom: i === progress.length - 1 ? 4 : 14,
                  borderTop: i === 0 ? undefined : '1px solid var(--grid)',
                }}
              />
            ))}
          </div>

          {showSuggestions && <SuggestionsCard suggestions={topSuggestions} onSet={setBudget} />}
        </>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="empty-state">
              <div className="big">🎯</div>
              <p style={{ fontWeight: 650, color: 'var(--ink)' }}>No budgets yet</p>
              <p className="small" style={{ maxWidth: 420, margin: '6px auto 18px' }}>
                Set a monthly limit for the categories you care about, and Finch will track your
                spending against it — including whether you're on pace as the month goes on.
              </p>
              <button
                className="btn btn-primary"
                onClick={() => setShowAdd(true)}
                disabled={availableCategories.length === 0}
              >
                + Add budget
              </button>
            </div>
          </div>
          {showSuggestions && <SuggestionsCard suggestions={topSuggestions} onSet={setBudget} />}
        </>
      )}

      {showAdd && availableCategories.length > 0 && (
        <AddBudgetModal
          availableCategories={availableCategories}
          estimates={estimates}
          onSave={(categoryId, monthlyLimit) => {
            setBudget(categoryId, monthlyLimit);
            setShowAdd(false);
          }}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
