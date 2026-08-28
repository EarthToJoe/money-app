import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../store';
import type { CreditStatus } from '../../lib/credits';
import { fmtUsd } from '../../lib/format';

interface MarkUsedProps {
  status: CreditStatus;
}

/**
 * Inline "Mark used" control for one credit in its current period.
 * Click → number input prefilled with the credit amount → Enter/Save records it.
 * Once a value is recorded, shows the recorded amount + Undo (clears to 0).
 */
export function MarkUsed({ status }: MarkUsedProps) {
  const setCreditUsage = useApp((s) => s.setCreditUsage);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const { account, credit, periodKey, recorded, autoDetected } = status;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const save = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0) return;
    setCreditUsage(account.id, credit.id, periodKey, Math.round(n * 100) / 100);
    setEditing(false);
  };

  const start = () => {
    setDraft(String(recorded ?? credit.amount));
    setEditing(true);
  };

  if (editing) {
    return (
      <form
        className="row"
        style={{ gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <span className="small muted">$</span>
        <input
          ref={inputRef}
          className="input tnum"
          type="number"
          min={0}
          step="0.01"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
          }}
          style={{ width: 88, padding: '4px 8px' }}
          aria-label={`Amount of ${credit.name} used`}
        />
        <button type="submit" className="btn btn-primary" style={{ padding: '4px 10px' }}>
          Save
        </button>
        <button type="button" className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </form>
    );
  }

  if (recorded !== undefined) {
    return (
      <div className="row" style={{ gap: 6 }}>
        <span className="badge badge-good tnum">Used {fmtUsd(recorded)}</span>
        <button className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={start} title="Change the recorded amount">
          Edit
        </button>
        <button
          className="btn btn-ghost"
          style={{ padding: '4px 8px' }}
          onClick={() => setCreditUsage(account.id, credit.id, periodKey, 0)}
        >
          Undo
        </button>
      </div>
    );
  }

  return (
    <div className="row" style={{ gap: 6 }}>
      {autoDetected > 0 && (
        <span className="chip" title={`${fmtUsd(autoDetected)} matched from your transactions this period`}>
          auto-detected {fmtUsd(autoDetected)}
        </span>
      )}
      <button className="btn" style={{ padding: '4px 10px' }} onClick={start}>
        Mark used
      </button>
    </div>
  );
}
