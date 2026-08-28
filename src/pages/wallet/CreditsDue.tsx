import { useMemo, useState } from 'react';
import type { CreditStatus } from '../../lib/credits';
import { fmtUsd } from '../../lib/format';
import { MarkUsed } from './MarkUsed';
import { daysBadgeClass, resetsLabel } from './helpers';

interface CreditsDueProps {
  /** All credits across accounts (creditsAll output). */
  credits: CreditStatus[];
}

type Window = '30' | 'all';

/** "Use before they reset" — unused statement credits, most urgent first. */
export function CreditsDue({ credits }: CreditsDueProps) {
  const [window, setWindow] = useState<Window>('30');

  const available = useMemo(() => credits.filter((c) => c.remaining > 0), [credits]);
  const shown = useMemo(
    () => (window === '30' ? available.filter((c) => c.daysLeft <= 30) : available),
    [available, window],
  );
  const totalAvailable = available.reduce((s, c) => s + c.remaining, 0);

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>
          Use before they reset
        </div>
        <div className="segmented">
          <button className={window === '30' ? 'active' : ''} onClick={() => setWindow('30')}>
            Next 30 days
          </button>
          <button className={window === 'all' ? 'active' : ''} onClick={() => setWindow('all')}>
            All
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="small muted" style={{ padding: '8px 0' }}>
          {available.length > 0
            ? 'Nothing resets in the next 30 days — switch to "All" to see every open credit.'
            : 'No unused statement credits right now. Credits from your card products appear here as their periods open.'}
        </p>
      ) : (
        <div className="table-scroll">
          {/* min-width keeps the columns readable: without it the narrow
              viewport crushes them into one-word-per-line slivers. */}
          <table className="table" style={{ minWidth: 480 }}>
            <tbody>
              {shown.map((c) => (
                  <tr key={`${c.account.id}:${c.credit.id}:${c.periodKey}`}>
                    <td>
                      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                        <span
                          className="dot"
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            flex: 'none',
                            marginTop: 6,
                            background: c.product.gradient[0],
                          }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{c.credit.name}</div>
                          <div className="small muted">{c.product.name}</div>
                          {/* How-to sits under the name rather than in its own
                              column, which had no min-width and collapsed. */}
                          <div className="small muted" style={{ marginTop: 4, lineHeight: 1.45 }}>
                            {c.credit.how}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="num tnum" style={{ whiteSpace: 'nowrap' }}>
                      {fmtUsd(c.remaining)} <span className="muted">of {fmtUsd(c.credit.amount)}</span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={daysBadgeClass(c.daysLeft)}>{resetsLabel(c.daysLeft)}</span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <MarkUsed status={c} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {totalAvailable > 0 && (
        <p className="small" style={{ marginTop: 10 }}>
          <strong className="tnum">{fmtUsd(totalAvailable)}</strong> in credits still available across your cards.
        </p>
      )}
    </div>
  );
}
