import type { CSSProperties, ReactNode } from 'react';
import type { Account, CardProduct } from '../../types';
import type { CardValue } from '../../lib/cardValue';
import { fmtCents, fmtDateLong, fmtNum } from '../../lib/format';

interface CardValueCardProps {
  account: Account;
  product: CardProduct;
  /** Null when the engine has nothing to measure yet. */
  value: CardValue | null;
}

/** Sits at the bottom of a card tile, so tiles in a row stay aligned. */
const BLOCK: CSSProperties = {
  marginTop: 'auto',
  borderTop: '1px solid var(--grid)',
  paddingTop: 12,
  display: 'grid',
  gap: 10,
};

/** "less than a month" / "1 month" / "7 months" */
function monthsLabel(months: number): string {
  const n = Math.round(months);
  if (n <= 0) return 'less than a month';
  return n === 1 ? '1 month' : `${n} months`;
}

interface FigureProps {
  label: string;
  value: string;
  sub?: ReactNode;
  /** Swatch tying this figure to its slice of the bar. */
  color?: string;
  opacity?: number;
  /** Net: bigger and bolder than the parts that make it up. */
  strong?: boolean;
  valueColor?: string;
}

function Figure({ label, value, sub, color, opacity, strong, valueColor }: FigureProps) {
  return (
    <div className="stat" style={{ flex: '1 1 104px', minWidth: 0 }}>
      <span className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {color && (
          <span
            style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: color, opacity }}
          />
        )}
        {label}
      </span>
      <span
        className="stat-value sm tnum"
        style={{ fontSize: strong ? 'var(--fs-xl)' : 'var(--fs-lg)', fontWeight: strong ? 800 : 700, color: valueColor }}
      >
        {value}
      </span>
      {sub ? <span className="small muted">{sub}</span> : null}
    </div>
  );
}

/**
 * "What this card returned" for one card, over the value engine's window.
 *
 * Deliberately not a verdict: it reports rewards, credits and bonus against
 * whatever fee the cardholder actually pays, and never argues about whether
 * the card is worth keeping. When the fee is waived the one real loss left is
 * a credit that expired unused, so that is the line that gets the badge.
 */
export function CardValueCard({ account, product, value: v }: CardValueCardProps) {
  const tint = product.gradient[0];

  if (!v) {
    return (
      <div style={BLOCK}>
        <div>
          <div className="section-title" style={{ marginBottom: 2 }}>
            What this card returned
          </div>
          <p className="small muted">Too new to show a return yet — check back after your first statement.</p>
        </div>
      </div>
    );
  }

  const unusedCents = Math.max(0, v.creditsAvailableCents - v.creditsUsedCents);
  const unusedLine =
    unusedCents > 0 ? (
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', rowGap: 4 }}>
        <span className="badge badge-warn">{fmtCents(unusedCents)} in credits went unused</span>
        <span className="small muted">They expire when the period resets.</span>
      </div>
    ) : null;

  // Opened inside the window, so the engine pro-rated everything it measured.
  const sinceOpened = Boolean(account.openedAt && account.openedAt >= v.windowStart);
  const windowTitle = sinceOpened ? `Since you opened it — ${monthsLabel(v.months)}` : 'Last 12 months';

  const header = (
    <div>
      <div className="section-title" style={{ marginBottom: 2 }}>
        What this card returned
      </div>
      <div className="small">
        {windowTitle}
        {/* A card opened today has a zero-length window; "Aug 25 – Aug 25" is noise. */}
        {v.windowStart !== v.windowEnd && (
          <span className="muted">
            {' '}
            · {fmtDateLong(v.windowStart)} – {fmtDateLong(v.windowEnd)}
          </span>
        )}
      </div>
    </div>
  );

  // Nothing has run through the card yet: a $0 or negative net here would be
  // an artifact of the card's age, not a result. Say so instead.
  const noActivity =
    v.spend === 0 && v.rewardValueCents === 0 && v.bonusValueCents === 0 && v.creditsUsedCents === 0;

  if (noActivity) {
    // Without an opened date a card that is one day old looks exactly like one
    // that sat idle all year, so Finch asks for the date instead of billing the
    // cardholder for a year of credits the card may never have had.
    const undated = !account.openedAt;
    return (
      <div style={BLOCK}>
        {header}
        <p className="small muted" style={{ margin: 0 }}>
          {sinceOpened
            ? 'Too new to show a return yet — check back after your first statement.'
            : undated
              ? 'No spending on this card in this window. Add the date you opened it above and Finch measures from there.'
              : 'No spending on this card in this window, so there is nothing to total up yet.'}
        </p>
        {/* An idle card still burns credits — but only say so once we know its age. */}
        {!sinceOpened && !undated && unusedLine}
      </div>
    );
  }

  const segments = [
    { key: 'rewards', label: 'Rewards earned', cents: v.rewardValueCents, opacity: 1 },
    { key: 'credits', label: 'Credits used', cents: v.creditsUsedCents, opacity: 0.5 },
    { key: 'bonus', label: 'Welcome bonus', cents: v.bonusValueCents, opacity: 0.26 },
  ].filter((s) => s.cents > 0);
  const barTotal = segments.reduce((sum, s) => sum + s.cents, 0);

  const feeValue = v.feeWaived ? 'Waived' : v.feeCents > 0 ? `−${fmtCents(v.feeCents)}` : 'None';
  const netColor =
    v.netValueCents > 0 ? 'var(--good-text)' : v.netValueCents < 0 ? 'var(--critical)' : undefined;

  return (
    <div style={BLOCK}>
      {header}

      {barTotal > 0 && (
        <div
          style={{ display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--surface-2)' }}
        >
          {segments.map((s) => (
            <div
              key={s.key}
              title={`${s.label}: ${fmtCents(s.cents)}`}
              style={{ width: `${(s.cents / barTotal) * 100}%`, background: tint, opacity: s.opacity }}
            />
          ))}
        </div>
      )}

      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', columnGap: 16, rowGap: 12 }}>
        <Figure
          label="Rewards"
          value={fmtCents(v.rewardValueCents)}
          sub={product.currency === 'cashback' ? undefined : `${fmtNum(v.pointsEarned)} ${v.currencyLabel}`}
          color={tint}
          opacity={1}
        />
        <Figure
          label="Credits used"
          value={fmtCents(v.creditsUsedCents)}
          sub={v.creditsAvailableCents > 0 ? `of ${fmtCents(v.creditsAvailableCents)} available` : undefined}
          color={tint}
          opacity={0.5}
        />
        {v.bonusValueCents > 0 && (
          <Figure label="Welcome bonus" value={fmtCents(v.bonusValueCents)} color={tint} opacity={0.26} />
        )}
        <Figure label="Fee" value={feeValue} />
        <Figure label="Net" value={fmtCents(v.netValueCents)} strong valueColor={netColor} />
      </div>

      {unusedLine}
    </div>
  );
}
