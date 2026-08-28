import { useMemo, useState } from 'react';
import { useApp } from '../store';
import type { ProgramKind } from '../types';
import { balanceRows, totalValueCents, type BalanceRow } from '../lib/loyalty';
import { fmtCents } from '../lib/format';
import { AddProgramModal } from './points/AddProgramModal';
import { BalanceTable } from './points/BalanceTable';
import { TransferPartners } from './points/TransferPartners';
import { todayIso } from './points/util';

const SECTIONS: Array<{ kind: ProgramKind; title: string }> = [
  { kind: 'bank', title: 'Bank points' },
  { kind: 'airline', title: 'Airlines' },
  { kind: 'hotel', title: 'Hotels' },
];

function sumValue(rows: BalanceRow[]): number {
  return rows.reduce((acc, r) => acc + r.valueCents, 0);
}

export default function Points() {
  const pointsBalances = useApp((s) => s.pointsBalances);
  const setPointsBalance = useApp((s) => s.setPointsBalance);
  const removePointsBalance = useApp((s) => s.removePointsBalance);

  const [modal, setModal] = useState<{ open: boolean; kind: 'all' | ProgramKind }>({ open: false, kind: 'all' });

  const today = todayIso();

  const rowsByKind = useMemo(
    () => ({
      bank: balanceRows(pointsBalances, 'bank'),
      airline: balanceRows(pointsBalances, 'airline'),
      hotel: balanceRows(pointsBalances, 'hotel'),
    }),
    [pointsBalances],
  );
  const total = useMemo(() => totalValueCents(pointsBalances), [pointsBalances]);
  const existingIds = useMemo(() => new Set(pointsBalances.map((b) => b.programId)), [pointsBalances]);

  const bankCount = rowsByKind.bank.length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Points</h1>
          <p className="page-subtitle">Every balance in one place, valued in dollars.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 8 }}>
        <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
          <div className="stat">
            <span className="stat-label">Total points value</span>
            <span className="stat-value tnum">{fmtCents(total)}</span>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <span className="chip">
                Bank points {fmtCents(sumValue(rowsByKind.bank))} · {bankCount} program{bankCount === 1 ? '' : 's'}
              </span>
              <span className="chip">Airlines {fmtCents(sumValue(rowsByKind.airline))}</span>
              <span className="chip">Hotels {fmtCents(sumValue(rowsByKind.hotel))}</span>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => setModal({ open: true, kind: 'all' })}>
            Add program
          </button>
        </div>
      </div>

      <p className="muted small" style={{ margin: '0 2px 20px' }}>
        Loyalty programs don't offer consumer APIs, so balances are entered here — each row shows when it was last updated.
      </p>

      {SECTIONS.map(({ kind, title }) => (
        <section key={kind} style={{ marginBottom: 20 }}>
          <h2 className="section-title">{title}</h2>
          <div className="card">
            <BalanceTable
              kind={kind}
              rows={rowsByKind[kind]}
              today={today}
              onSave={(programId, balance) => setPointsBalance(programId, balance)}
              onRemove={removePointsBalance}
            />
          </div>
        </section>
      ))}

      <section style={{ marginBottom: 20 }}>
        <h2 className="section-title">Transfers</h2>
        <TransferPartners
          balances={pointsBalances}
          bankRows={rowsByKind.bank}
          onAddBank={() => setModal({ open: true, kind: 'bank' })}
        />
      </section>

      {modal.open && (
        <AddProgramModal
          existingIds={existingIds}
          initialKind={modal.kind}
          onSave={(programId, balance) => setPointsBalance(programId, balance)}
          onClose={() => setModal({ open: false, kind: 'all' })}
        />
      )}
    </div>
  );
}
