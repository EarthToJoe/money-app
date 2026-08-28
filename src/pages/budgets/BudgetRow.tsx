import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { CategoryId } from '../../types';
import type { BudgetProgress } from '../../lib/analytics';
import { categoryDef } from '../../data/categories';
import { fmtUsd } from '../../lib/format';
import { BudgetBar } from './BudgetBar';

interface BudgetRowProps {
  progress: BudgetProgress;
  /** Set only for the current month — renders the vertical pace marker. */
  paceFraction?: number;
  onSaveLimit: (categoryId: CategoryId, monthlyLimit: number) => void;
  onRemove: (categoryId: CategoryId) => void;
  style?: CSSProperties;
}

/** One budget in the list: category identity, spent vs limit, inline edit, remove. */
export default function BudgetRow({
  progress,
  paceFraction,
  onSaveLimit,
  onRemove,
  style,
}: BudgetRowProps) {
  const { categoryId, limit, spent, ratio } = progress;
  const def = categoryDef(categoryId);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const remaining = limit - spent;
  const parsed = Number(draft);
  const draftValid = draft.trim() !== '' && Number.isFinite(parsed) && parsed > 0;

  const startEdit = () => {
    setDraft(String(limit));
    setEditing(true);
  };

  const commit = () => {
    if (!draftValid) return;
    onSaveLimit(categoryId, parsed);
    setEditing(false);
  };

  return (
    <div style={style}>
      <div className="spread" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 17, lineHeight: 1 }}>{def.emoji}</span>
          <span style={{ fontWeight: 600 }}>{def.label}</span>
        </div>
        {editing ? (
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <span className="small muted">Monthly limit</span>
            <input
              className="input tnum"
              type="number"
              min={0}
              step={25}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(false);
              }}
              style={{ width: 110 }}
              aria-label={`Monthly limit for ${def.label}`}
            />
            <button className="btn btn-primary" onClick={commit} disabled={!draftValid}>
              Save
            </button>
            <button className="btn btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="row" style={{ gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <span className="small tnum">
              {fmtUsd(spent)} <span className="muted">of {fmtUsd(limit)}</span>
            </span>
            {remaining >= 0 ? (
              <span className="small muted tnum">{fmtUsd(remaining)} left</span>
            ) : (
              <span className="small tnum" style={{ color: 'var(--critical)', fontWeight: 600 }}>
                {fmtUsd(-remaining)} over
              </span>
            )}
            <div className="row" style={{ gap: 2 }}>
              <button className="btn btn-ghost" onClick={startEdit}>
                Edit
              </button>
              <button
                className="btn btn-ghost btn-danger"
                onClick={() => onRemove(categoryId)}
                aria-label={`Remove ${def.label} budget`}
              >
                ✕
              </button>
            </div>
          </div>
        )}
      </div>
      <BudgetBar ratio={ratio} color={def.color} paceFraction={paceFraction} />
    </div>
  );
}
