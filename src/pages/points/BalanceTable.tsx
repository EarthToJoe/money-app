import { useRef, useState } from 'react';
import type { ProgramKind } from '../../types';
import type { BalanceRow } from '../../lib/loyalty';
import { fmtCents, fmtDateShort, fmtNum } from '../../lib/format';
import { KIND_PLURAL, ProgramDot, STALE_DAYS, daysBetween } from './util';

interface BalanceTableProps {
  kind: ProgramKind;
  rows: BalanceRow[];
  today: string;
  onSave: (programId: string, balance: number) => void;
  onRemove: (programId: string) => void;
}

/** One section (bank / airline / hotel): a table of balances with inline editing. */
export function BalanceTable({ kind, rows, today, onSave, onRemove }: BalanceTableProps) {
  if (rows.length === 0) {
    return <p className="muted small">No {KIND_PLURAL[kind]} yet.</p>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Program</th>
              <th className="num">Balance</th>
              <th className="num">Value</th>
              <th>Updated</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const age = daysBetween(r.updatedAt, today);
              const stale = age > STALE_DAYS;
              return (
                <tr key={r.program.id}>
                  <td>
                    <div className="row" style={{ gap: 9, minWidth: 0 }}>
                      <ProgramDot color={r.program.color} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 650 }}>{r.program.name}</div>
                        <div className="muted small">
                          {r.program.short}
                          {r.note ? ` · ${r.note}` : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="num">
                    <BalanceCell
                      value={r.balance}
                      unit={r.program.unit}
                      label={r.program.name}
                      onSave={(v) => onSave(r.program.id, v)}
                    />
                  </td>
                  <td className="num tnum">{fmtCents(r.valueCents)}</td>
                  <td>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="tnum">{fmtDateShort(r.updatedAt)}</span>
                      {stale && (
                        <span className="badge badge-warn" title={`Last updated ${age} days ago`}>
                          stale
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', width: 44 }}>
                    <button
                      className="btn btn-ghost"
                      onClick={() => onRemove(r.program.id)}
                      aria-label={`Remove ${r.program.name}`}
                      title="Remove"
                      style={{ padding: '3px 8px' }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface BalanceCellProps {
  value: number;
  unit: 'points' | 'miles';
  label: string;
  onSave: (value: number) => void;
}

/** Click the number → numeric input. Enter/blur saves, Escape cancels. */
function BalanceCell({ value, unit, label, onSave }: BalanceCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Guards so a blur fired during unmount after Enter/Escape doesn't double-save or resurrect a cancelled edit.
  const settled = useRef(false);

  const start = () => {
    setDraft(String(value));
    settled.current = false;
    setEditing(true);
  };

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n) && n >= 0) {
      const rounded = Math.round(n);
      if (rounded !== value) onSave(rounded);
    }
    setEditing(false);
  };

  const cancel = () => {
    settled.current = true;
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        className="input tnum"
        type="number"
        min={0}
        step={1}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            e.stopPropagation();
            cancel();
          }
        }}
        aria-label={`${label} balance`}
        style={{ width: 130, textAlign: 'right', padding: '4px 8px' }}
      />
    );
  }

  return (
    <button
      className="btn btn-ghost tnum"
      onClick={start}
      title="Click to update"
      aria-label={`Edit ${label} balance`}
      style={{ padding: '3px 8px', fontWeight: 650, justifyContent: 'flex-end' }}
    >
      {fmtNum(value)}
      <span className="muted small" style={{ fontWeight: 500 }}>
        {unit === 'miles' ? 'mi' : 'pts'}
      </span>
    </button>
  );
}
