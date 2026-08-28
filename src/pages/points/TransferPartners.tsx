import { useMemo, useState } from 'react';
import type { LoyaltyProgram, PointsBalance } from '../../types';
import { LOYALTY_PROGRAMS, partnersFrom, partnersTo, programById } from '../../data/programs';
import { reachability, type BalanceRow } from '../../lib/loyalty';
import { fmtCents, fmtNum } from '../../lib/format';
import { KIND_LABEL, ProgramDot, fmtRatio } from './util';

type Mode = 'from' | 'to';

interface TransferPartnersProps {
  balances: PointsBalance[];
  /** Bank-currency balances the user holds (from balanceRows(balances, 'bank')). */
  bankRows: BalanceRow[];
  onAddBank: () => void;
}

/** Where bank points can go, and how many points of a destination program the user can muster. */
export function TransferPartners({ balances, bankRows, onAddBank }: TransferPartnersProps) {
  const [mode, setMode] = useState<Mode>('from');
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);

  const destinations = useMemo(
    () =>
      LOYALTY_PROGRAMS.filter((p) => p.kind !== 'bank').sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
      ),
    [],
  );
  const airlines = destinations.filter((p) => p.kind === 'airline');
  const hotels = destinations.filter((p) => p.kind === 'hotel');

  // Fall back to the first option whenever the chosen id is no longer available.
  const from = bankRows.find((r) => r.program.id === fromId) ?? bankRows[0];
  const to = destinations.find((p) => p.id === toId) ?? destinations[0];

  const header = (
    <div className="spread" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
      <div className="card-title" style={{ marginBottom: 0 }}>
        Transfer partners
      </div>
      <div className="segmented">
        <button className={mode === 'from' ? 'active' : ''} onClick={() => setMode('from')}>
          From my bank points
        </button>
        <button className={mode === 'to' ? 'active' : ''} onClick={() => setMode('to')}>
          To a program
        </button>
      </div>
    </div>
  );

  if (bankRows.length === 0) {
    return (
      <div className="card">
        {header}
        <div className="empty-state">
          <div className="big">🔁</div>
          <p>Add a bank points balance — Chase UR, Amex MR, Citi ThankYou, Capital One, Bilt — to see where it can transfer and what it's worth there.</p>
          <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={onAddBank}>
            Add bank program
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      {header}
      {mode === 'from' ? (
        <FromView from={from} bankRows={bankRows} onChange={setFromId} />
      ) : (
        <ToView to={to} airlines={airlines} hotels={hotels} balances={balances} onChange={setToId} />
      )}
      <p className="muted small" style={{ marginTop: 14 }}>
        Transfer ratios change and some partners run limited-time bonuses. Not financial advice — verify terms with the issuer.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface FromViewProps {
  from: BalanceRow | undefined;
  bankRows: BalanceRow[];
  onChange: (id: string) => void;
}

function FromView({ from, bankRows, onChange }: FromViewProps) {
  const partners = useMemo(() => {
    if (!from) return [];
    return partnersFrom(from.program.id)
      .map((t) => {
        const program = programById(t.to);
        const yields = Math.floor(from.balance * t.ratio);
        const valueCents = program ? Math.round(yields * program.valueCents) : 0;
        return { t, program, yields, valueCents };
      })
      .sort((a, b) => b.valueCents - a.valueCents);
  }, [from]);

  if (!from) return null;

  return (
    <>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <label className="small muted" htmlFor="transfer-from">
          From
        </label>
        <select id="transfer-from" className="select" value={from.program.id} onChange={(e) => onChange(e.target.value)}>
          {bankRows.map((r) => (
            <option key={r.program.id} value={r.program.id}>
              {r.program.name} · {fmtNum(r.balance)} {r.program.short}
            </option>
          ))}
        </select>
        <span className="small muted">
          {partners.length} partner{partners.length === 1 ? '' : 's'}
        </span>
      </div>

      {partners.length === 0 ? (
        <p className="muted small">No transfer partners on file for {from.program.name}.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Program</th>
                  <th>Ratio</th>
                  <th>Yield</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {partners.map(({ t, program, yields, valueCents }) => (
                  <tr key={t.to}>
                    <td>
                      <div className="row" style={{ gap: 9 }}>
                        <ProgramDot color={program?.color ?? 'var(--ink-3)'} />
                        <div>
                          <div style={{ fontWeight: 650 }}>{program?.name ?? t.to}</div>
                          {program && (
                            <div className="muted small">
                              {program.short} · {KIND_LABEL[program.kind]}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="tnum">{fmtRatio(t.ratio)}</td>
                    <td>
                      <div className="tnum">
                        your {fmtNum(from.balance)} {from.program.short} → {fmtNum(yields)} {program?.short ?? t.to}
                      </div>
                      {t.note && <div className="muted small">{t.note}</div>}
                    </td>
                    <td className="num tnum">{program ? fmtCents(valueCents) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

interface ToViewProps {
  to: LoyaltyProgram | undefined;
  airlines: LoyaltyProgram[];
  hotels: LoyaltyProgram[];
  balances: PointsBalance[];
  onChange: (id: string) => void;
}

function ToView({ to, airlines, hotels, balances, onChange }: ToViewProps) {
  const reach = useMemo(() => (to ? reachability(to.id, balances) : null), [to, balances]);
  const inbound = useMemo(() => (to ? partnersTo(to.id) : []), [to]);

  if (!to) {
    return <p className="muted small">Program list loading…</p>;
  }

  const inboundNames = inbound
    .map((t) => programById(t.from)?.name ?? t.from)
    .filter((n, i, arr) => arr.indexOf(n) === i);

  return (
    <>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <label className="small muted" htmlFor="transfer-to">
          To
        </label>
        <select id="transfer-to" className="select" value={to.id} onChange={(e) => onChange(e.target.value)}>
          {airlines.length > 0 && (
            <optgroup label="Airlines">
              {airlines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {hotels.length > 0 && (
            <optgroup label="Hotels">
              {hotels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      {reach === null ? (
        <p className="muted small">No reachability data for {to.name} yet.</p>
      ) : (
        <>
          <div className="stat" style={{ marginBottom: 12 }}>
            <span className="stat-label">You can muster</span>
            <span className="stat-value sm tnum">
              {fmtNum(reach.reachable)} {to.short} {to.unit}
            </span>
            <span className="stat-delta">
              ≈ {fmtCents(Math.round(reach.reachable * to.valueCents))} at planning value · {fmtNum(reach.own)} already in the account
              {reach.sources.length > 0 && `, ${fmtNum(reach.reachable - reach.own)} via transfers`}
            </span>
          </div>

          {reach.sources.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Ratio</th>
                      <th>Yield</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <div className="row" style={{ gap: 9 }}>
                          <ProgramDot color={to.color} />
                          <span style={{ fontWeight: 650 }}>Own balance</span>
                        </div>
                      </td>
                      <td className="muted">—</td>
                      <td className="tnum">
                        {fmtNum(reach.own)} {to.short}
                      </td>
                    </tr>
                    {reach.sources.map((s) => (
                      <tr key={s.fromProgram.id}>
                        <td>
                          <div className="row" style={{ gap: 9 }}>
                            <ProgramDot color={s.fromProgram.color} />
                            <div>
                              <div style={{ fontWeight: 650 }}>{s.fromProgram.name}</div>
                              <div className="muted small">{s.fromProgram.short}</div>
                            </div>
                          </div>
                        </td>
                        <td className="tnum">{fmtRatio(s.ratio)}</td>
                        <td>
                          <div className="tnum">
                            your {fmtNum(s.fromBalance)} {s.fromProgram.short} → {fmtNum(s.yields)} {to.short}
                          </div>
                          {s.note && <div className="muted small">{s.note}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : inbound.length === 0 ? (
            <p className="muted small">No bank currency transfers into {to.name} — only points earned directly count here.</p>
          ) : (
            <p className="muted small">
              {to.name} accepts transfers from {inboundNames.join(', ')} — none of your bank balances are in those currencies.
            </p>
          )}
        </>
      )}
    </>
  );
}
