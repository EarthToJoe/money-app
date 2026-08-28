import { useEffect, useState } from 'react';
import type { CategoryId } from '../../types';
import { categoryDef } from '../../data/categories';
import { fmtDateLong, fmtUsd } from '../../lib/format';

// ---------------------------------------------------------------------------
// The shape and the wording of a budget suggestion. It lives in this leaf
// module so the Budgets page (which computes the estimate) and this modal
// (which prefills from it) describe the same number the same way, with the
// import pointing one direction only.

/** A single purchase left out of an estimate because it isn't recurring spend. */
export interface OneOffPurchase {
  merchant: string;
  date: string;
  amount: number;
}

export interface SpendEstimate {
  /** Typical monthly spend: median of the trailing months (mean if too few). */
  typical: number;
  /** `typical` rounded up to the nearest $25 — what a one-click "Set $X/mo" applies. */
  suggested: number;
  /** How many trailing months carried any data at all. */
  months: number;
  /** True when `typical` is a mean because there weren't enough months for a median. */
  usedMean: boolean;
  /** One-off purchases excluded from `typical`, newest first. */
  excluded: OneOffPurchase[];
}

/** Budget suggestions round the typical month UP to the nearest $25. */
export function roundUpTo25(n: number): number {
  return Math.ceil(n / 25) * 25;
}

/** Tooltip text saying what the estimate is an estimate from. */
export function estimateBasisText(e: SpendEstimate): string {
  const months = `${e.months} month${e.months === 1 ? '' : 's'}`;
  return e.usedMean
    ? `Average of the last ${months} — not enough history yet to take a median`
    : `Median of the last ${months}, so one unusual month can't skew it`;
}

export function oneOffLabel(count: number): string {
  return `Excludes ${count} one-off purchase${count === 1 ? '' : 's'}`;
}

/** Names every excluded purchase, for the `title` on the muted "Excludes…" line. */
export function oneOffTitle(list: OneOffPurchase[]): string {
  return `Left out as one-offs: ${list
    .map((o) => `${o.merchant} ${fmtUsd(o.amount)} on ${fmtDateLong(o.date)}`)
    .join(', ')}`;
}

interface AddBudgetModalProps {
  /** Spending categories that don't have a budget yet, in canonical category order. */
  availableCategories: CategoryId[];
  /** spendEstimatesByCategory(txns) — the outlier-robust typical month, used to prefill. */
  estimates: Map<CategoryId, SpendEstimate>;
  onSave: (categoryId: CategoryId, monthlyLimit: number) => void;
  onClose: () => void;
}

export default function AddBudgetModal({
  availableCategories,
  estimates,
  onSave,
  onClose,
}: AddBudgetModalProps) {
  const estimateFor = (id: CategoryId | undefined): SpendEstimate | undefined => {
    if (id === undefined) return undefined;
    const e = estimates.get(id);
    return e !== undefined && e.suggested > 0 ? e : undefined;
  };

  const [category, setCategory] = useState<CategoryId | undefined>(availableCategories[0]);
  const [limit, setLimit] = useState<string>(() => {
    const e = estimateFor(availableCategories[0]);
    return e !== undefined ? String(e.suggested) : '';
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (category === undefined) return null;

  const estimate = estimateFor(category);
  const parsed = Number(limit);
  const valid = limit.trim() !== '' && Number.isFinite(parsed) && parsed > 0;

  const handleCategoryChange = (id: CategoryId) => {
    setCategory(id);
    const e = estimateFor(id);
    setLimit(e !== undefined ? String(e.suggested) : '');
  };

  const submit = () => {
    if (!valid) return;
    onSave(category, parsed);
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={{ maxWidth: 460 }} role="dialog" aria-label="Add budget">
        <div className="spread" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700 }}>Add budget</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label
            className="small"
            htmlFor="add-budget-category"
            style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}
          >
            Category
          </label>
          <select
            id="add-budget-category"
            className="select"
            style={{ width: '100%', marginBottom: 14 }}
            value={category}
            onChange={(e) => handleCategoryChange(e.target.value as CategoryId)}
          >
            {availableCategories.map((id) => {
              const def = categoryDef(id);
              return (
                <option key={id} value={id}>
                  {def.emoji} {def.label}
                </option>
              );
            })}
          </select>

          <label
            className="small"
            htmlFor="add-budget-limit"
            style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}
          >
            Monthly limit
          </label>
          <input
            id="add-budget-limit"
            className="input tnum"
            type="number"
            min={0}
            step={25}
            placeholder="e.g. 400"
            autoFocus
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            style={{ width: '100%' }}
          />
          {estimate !== undefined && (
            <>
              <p className="small muted" style={{ marginTop: 6 }} title={estimateBasisText(estimate)}>
                Suggested from a typical month of your recent spending ({fmtUsd(estimate.typical)}
                /mo).
              </p>
              {estimate.excluded.length > 0 && (
                <p className="small muted" style={{ marginTop: 2 }} title={oneOffTitle(estimate.excluded)}>
                  {oneOffLabel(estimate.excluded.length)}
                </p>
              )}
            </>
          )}

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!valid}>
              Save budget
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
