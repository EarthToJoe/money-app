interface BudgetBarProps {
  /** spent / limit, uncapped (1.2 = 20% over). Visual width is capped at 100%. */
  ratio: number;
  /** Base fill color (category color, or var(--accent) for the summary bar). */
  color: string;
  /** When set (current month only), renders a thin vertical pace marker at this fraction. */
  paceFraction?: number;
}

/**
 * Budget progress bar. Fill turns var(--warning) past 85% and var(--critical)
 * past 100% of the limit, regardless of the base color.
 */
export function BudgetBar({ ratio, color, paceFraction }: BudgetBarProps) {
  const fill = ratio > 1 ? 'var(--critical)' : ratio > 0.85 ? 'var(--warning)' : color;
  const widthPct = Math.min(1, Math.max(0, ratio)) * 100;

  return (
    <div style={{ position: 'relative' }}>
      <div className="progress">
        <div
          className="progress-fill"
          style={{ width: `${widthPct.toFixed(2)}%`, background: fill }}
        />
      </div>
      {paceFraction !== undefined && (
        <div
          aria-hidden
          title="Where you'd be if spending were spread evenly across the month"
          style={{
            position: 'absolute',
            left: `calc(${(Math.min(1, Math.max(0, paceFraction)) * 100).toFixed(2)}% - 1px)`,
            top: -3,
            bottom: -3,
            width: 2,
            borderRadius: 1,
            background: 'rgba(11, 11, 11, 0.35)',
          }}
        />
      )}
    </div>
  );
}
