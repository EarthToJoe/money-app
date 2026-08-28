import { useMemo, useState } from 'react';
import { LOYALTY_PROGRAMS } from '../../data/programs';
import {
  planBigPurchase,
  type BigPurchaseInput,
  type BigPurchasePlan,
  type PaymentOption,
  type PurchaseContext,
} from '../../lib/advisor';
import { fmtCents } from '../../lib/format';
import { Disclaimer } from './bits';

type Kind = BigPurchaseInput['kind'];

const KINDS: Array<{ id: Kind; label: string }> = [
  { id: 'flight', label: 'Flight' },
  { id: 'hotel', label: 'Hotel' },
  { id: 'other', label: 'Other' },
];

function verdictBadge(verdict: PaymentOption['verdict']): { cls: string; label: string } {
  switch (verdict) {
    case 'best':
      return { cls: 'badge badge-good', label: 'Best' };
    case 'good':
      return { cls: 'badge badge-neutral', label: 'Good' };
    case 'ok':
      return { cls: 'badge badge-neutral', label: 'OK' };
    case 'poor':
      return { cls: 'badge badge-bad', label: 'Poor' };
  }
}

export function BigPurchasePlanner({ ctx }: { ctx: PurchaseContext }) {
  const [kind, setKind] = useState<Kind>('flight');
  const [programId, setProgramId] = useState('');
  const [cashText, setCashText] = useState('');
  const [pointsText, setPointsText] = useState('');
  const [label, setLabel] = useState('');
  const [plan, setPlan] = useState<BigPurchasePlan | null>(null);

  const programs = useMemo(() => {
    if (kind === 'other') return [];
    const want = kind === 'flight' ? 'airline' : 'hotel';
    return LOYALTY_PROGRAMS.filter((p) => p.kind === want);
  }, [kind]);

  const cashPrice = parseFloat(cashText);
  const pointsPrice = parseFloat(pointsText.replace(/,/g, ''));
  const canPlan = Number.isFinite(cashPrice) && cashPrice > 0;

  const runPlan = () => {
    if (!canPlan) return;
    const input: BigPurchaseInput = {
      kind,
      programId: programId || undefined,
      cashPrice,
      pointsPrice: Number.isFinite(pointsPrice) && pointsPrice > 0 ? pointsPrice : undefined,
      label: label.trim() || undefined,
    };
    setPlan(planBigPurchase(input, ctx));
  };

  return (
    <div className="card">
      <div className="card-title">Plan a big purchase</div>

      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <div>
          <span className="small muted" style={{ display: 'block', marginBottom: 4 }}>
            What is it?
          </span>
          <div className="segmented">
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                className={kind === k.id ? 'active' : undefined}
                onClick={() => {
                  setKind(k.id);
                  setProgramId('');
                }}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {kind !== 'other' && (
          <div>
            <label className="small muted" htmlFor="plan-program" style={{ display: 'block', marginBottom: 4 }}>
              {kind === 'flight' ? 'Airline program' : 'Hotel program'}
            </label>
            <select
              id="plan-program"
              className="select"
              value={programId}
              onChange={(e) => setProgramId(e.target.value)}
            >
              <option value="">Not sure / other</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="small muted" htmlFor="plan-cash" style={{ display: 'block', marginBottom: 4 }}>
            Cash price
          </label>
          <div className="row" style={{ gap: 6 }}>
            <span className="muted">$</span>
            <input
              id="plan-cash"
              className="input tnum"
              style={{ width: 110 }}
              inputMode="decimal"
              placeholder="1600"
              value={cashText}
              onChange={(e) => setCashText(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="small muted" htmlFor="plan-points" style={{ display: 'block', marginBottom: 4 }}>
            Points price <span style={{ textTransform: 'none' }}>(if you looked up the award)</span>
          </label>
          <input
            id="plan-points"
            className="input tnum"
            style={{ width: 150 }}
            inputMode="numeric"
            placeholder="e.g. 60,000"
            value={pointsText}
            onChange={(e) => setPointsText(e.target.value)}
          />
        </div>

        <div style={{ flex: '1 1 180px', minWidth: 160 }}>
          <label className="small muted" htmlFor="plan-label" style={{ display: 'block', marginBottom: 4 }}>
            Label
          </label>
          <input
            id="plan-label"
            className="input"
            style={{ width: '100%' }}
            placeholder="SFO→JFK in October"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <button className="btn btn-primary" disabled={!canPlan} onClick={runPlan}>
          Plan it
        </button>
      </div>

      {plan && (
        <div style={{ marginTop: 16 }}>
          {plan.summary && (
            <div className="banner" style={{ alignItems: 'flex-start', lineHeight: 1.5 }}>
              {plan.summary}
            </div>
          )}

          {plan.options.length === 0 ? (
            <div className="empty-state" style={{ padding: '28px 24px' }}>
              <p>Nothing to compare yet — add cards and points balances so Finch has options to weigh.</p>
            </div>
          ) : (
            <div style={{ marginTop: 4 }}>
              {plan.options.map((o, i) => {
                const badge = verdictBadge(o.verdict);
                return (
                  <div
                    key={o.id}
                    style={{ padding: '13px 0', borderTop: i === 0 && !plan.summary ? 'none' : '1px solid var(--grid)' }}
                  >
                    <div className="spread" style={{ flexWrap: 'wrap' }}>
                      <div className="row">
                        <span className={badge.cls}>{badge.label}</span>
                        <span style={{ fontWeight: 650 }}>{o.title}</span>
                      </div>
                      <div className="row">
                        <span className="tnum" style={{ fontWeight: 650 }}>
                          {fmtCents(o.netCostCents)}
                        </span>
                        <span className="small muted">net</span>
                        {o.centsPerPoint !== undefined && (
                          <span className="chip">{(Math.round(o.centsPerPoint * 10) / 10).toString()}¢/pt</span>
                        )}
                      </div>
                    </div>
                    {o.details.length > 0 && (
                      <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--ink-2)' }}>
                        {o.details.map((d) => (
                          <li key={d} style={{ marginTop: 2 }}>
                            {d}
                          </li>
                        ))}
                      </ul>
                    )}
                    {o.steps && o.steps.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        {o.steps.map((s, j) => (
                          <div key={s} className="small muted" style={{ marginTop: 2 }}>
                            {j + 1}. {s}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Disclaimer />
        </div>
      )}
    </div>
  );
}
