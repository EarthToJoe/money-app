import { useMemo, useState } from 'react';
import type { LoyaltyProgram, ProgramKind } from '../../types';
import { LOYALTY_PROGRAMS } from '../../data/programs';
import { fmtCents, fmtNum } from '../../lib/format';
import { Modal } from '../accounts/Modal';
import { KIND_LABEL, ProgramDot } from './util';

type KindFilter = 'all' | ProgramKind;

const FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'bank', label: 'Bank' },
  { id: 'airline', label: 'Airline' },
  { id: 'hotel', label: 'Hotel' },
];

const KIND_ORDER: Record<ProgramKind, number> = { bank: 0, airline: 1, hotel: 2 };

interface AddProgramModalProps {
  /** Program ids that already have a balance — hidden from the picker. */
  existingIds: ReadonlySet<string>;
  initialKind?: KindFilter;
  onSave: (programId: string, balance: number) => void;
  onClose: () => void;
}

/** Pick a loyalty program, enter a balance, save. */
export function AddProgramModal({ existingIds, initialKind = 'all', onSave, onClose }: AddProgramModalProps) {
  const [kind, setKind] = useState<KindFilter>(initialKind);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<LoyaltyProgram | null>(null);
  const [balance, setBalance] = useState('');

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return LOYALTY_PROGRAMS.filter((p) => !existingIds.has(p.id))
      .filter((p) => kind === 'all' || p.kind === kind)
      .filter(
        (p) =>
          q === '' ||
          p.name.toLowerCase().includes(q) ||
          p.short.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q),
      )
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
  }, [existingIds, kind, query]);

  const parsed = Number(balance);
  const valid = balance.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;

  const save = () => {
    if (!picked || !valid) return;
    onSave(picked.id, Math.round(parsed));
    onClose();
  };

  if (picked) {
    const unit = picked.unit === 'miles' ? 'miles' : 'points';
    const valueCents = valid ? Math.round(parsed * picked.valueCents) : 0;
    return (
      <Modal title={`Add ${picked.name}`} subtitle={`${picked.short} · ${KIND_LABEL[picked.kind]} · planning value ${picked.valueCents}¢ per ${picked.unit === 'miles' ? 'mile' : 'point'}`} onClose={onClose} maxWidth={460}>
        <div className="row" style={{ gap: 10, marginBottom: 14 }}>
          <ProgramDot color={picked.color} size={12} />
          <span style={{ fontWeight: 650 }}>{picked.name}</span>
        </div>
        {picked.note && (
          <p className="small muted" style={{ marginBottom: 12 }}>
            {picked.note}
          </p>
        )}
        <label className="stat-label" htmlFor="points-balance-input" style={{ display: 'block', marginBottom: 6 }}>
          Current balance ({unit})
        </label>
        <input
          id="points-balance-input"
          className="input tnum"
          type="number"
          min={0}
          step={1}
          autoFocus
          placeholder="0"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          style={{ width: '100%' }}
        />
        <p className="small muted" style={{ marginTop: 8 }}>
          {valid ? `${fmtNum(parsed)} ${picked.short} ≈ ${fmtCents(valueCents)} at planning value.` : 'Enter the balance shown in your loyalty account.'}
        </p>
        <div className="spread" style={{ marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={() => setPicked(null)}>
            ← Back
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!valid}>
            Save balance
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add program" subtitle="Pick a loyalty program, then enter your current balance." onClose={onClose} maxWidth={560}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {FILTERS.map((f) => {
          const active = f.id === kind;
          return (
            <button
              key={f.id}
              className="chip"
              onClick={() => setKind(f.id)}
              aria-pressed={active}
              style={
                active
                  ? { background: 'var(--ink)', color: 'var(--surface)', border: 0, cursor: 'pointer' }
                  : { border: 0, cursor: 'pointer' }
              }
            >
              {f.label}
            </button>
          );
        })}
      </div>
      <input
        className="input"
        type="search"
        autoFocus
        placeholder="Search programs…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search programs"
        style={{ width: '100%', marginBottom: 12 }}
      />

      {LOYALTY_PROGRAMS.length === 0 ? (
        <div className="empty-state" style={{ padding: '32px 16px' }}>
          <p>Program list loading…</p>
        </div>
      ) : candidates.length === 0 ? (
        <div className="empty-state" style={{ padding: '32px 16px' }}>
          <p>{query.trim() ? `Nothing matches “${query.trim()}”.` : 'Every program in this group is already tracked.'}</p>
        </div>
      ) : (
        <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
          <div className="table-scroll">
            <table className="table">
              <tbody>
                {candidates.map((p) => (
                  <tr key={p.id}>
                    <td style={{ padding: 0 }}>
                      <button
                        className="btn btn-ghost"
                        onClick={() => setPicked(p)}
                        style={{ width: '100%', justifyContent: 'flex-start', borderRadius: 0, padding: '9px 12px', gap: 10 }}
                      >
                        <ProgramDot color={p.color} />
                        <span style={{ fontWeight: 650 }}>{p.name}</span>
                        <span className="muted small" style={{ fontWeight: 500 }}>
                          {p.short}
                        </span>
                        <span className="badge badge-neutral" style={{ marginLeft: 'auto' }}>
                          {KIND_LABEL[p.kind]}
                        </span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
