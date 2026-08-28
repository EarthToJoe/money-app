import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TooltipProps } from 'recharts';
import { monthLabel, monthLabelShort } from '../../lib/analytics';
import { fmtUsd, fmtUsdCompact } from '../../lib/format';

// Ink & grid colors from src/styles/tokens.css. SVG presentation attributes
// can't resolve CSS vars reliably, so we use the hex values directly.
const INK = '#0b0b0b';
const INK_2 = '#52514e';
const INK_3 = '#898781';
const GRID = '#e1e0d9';

export interface EarningsSeries {
  key: string; // accountId — the dataKey in each row
  name: string; // card product name
  color: string; // product.gradient[0]
}

interface EarningsChartProps {
  /** One row per month: { month: 'YYYY-MM', [accountId]: dollarsEarned } */
  rows: Array<Record<string, number | string>>;
  series: EarningsSeries[];
}

interface SegmentShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  payload?: Record<string, number | string>;
}

const STACK_GAP = 2;

/**
 * Custom stacked-bar segment: 2px gap between segments, rounded top corners
 * on whichever segment is actually topmost for that month (so months where a
 * card earned nothing still get a rounded cap).
 */
function makeSegment(seriesKeys: string[], ownKey: string) {
  return (raw: unknown): JSX.Element => {
    const p = raw as SegmentShapeProps;
    const x = p.x ?? 0;
    const y = p.y ?? 0;
    const w = p.width ?? 0;
    const h = p.height ?? 0;
    if (w <= 0 || h <= 0) return <g />;

    const row = p.payload ?? {};
    let topKey: string | undefined;
    for (const k of seriesKeys) {
      const v = row[k];
      if (typeof v === 'number' && v > 0) topKey = k;
    }
    const isTop = topKey === ownKey;
    const yy = isTop ? y : y + STACK_GAP;
    const hh = isTop ? h : h - STACK_GAP;
    if (hh <= 0) return <g />;

    if (!isTop) return <rect x={x} y={yy} width={w} height={hh} fill={p.fill} />;

    const r = Math.min(4, w / 2, hh);
    const d = [
      `M${x},${yy + r}`,
      `Q${x},${yy} ${x + r},${yy}`,
      `L${x + w - r},${yy}`,
      `Q${x + w},${yy} ${x + w},${yy + r}`,
      `L${x + w},${yy + hh}`,
      `L${x},${yy + hh}`,
      'Z',
    ].join(' ');
    return <path d={d} fill={p.fill} />;
  };
}

function EarningsTip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const entries = [...payload].reverse(); // visual top of the stack first
  const total = payload.reduce((s, e) => s + (typeof e.value === 'number' ? e.value : 0), 0);
  return (
    <div
      style={{
        background: '#fcfcfb',
        border: '1px solid rgba(11, 11, 11, 0.1)',
        borderRadius: 12,
        boxShadow: '0 2px 10px rgba(11, 11, 11, 0.07)',
        padding: '10px 12px',
        fontSize: 12.5,
        minWidth: 190,
      }}
    >
      <div style={{ fontWeight: 650, color: INK, marginBottom: 6 }}>{monthLabel(String(label))}</div>
      {entries.map((e) => (
        <div
          key={String(e.dataKey)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}
        >
          <span
            style={{ width: 8, height: 8, borderRadius: '50%', background: e.color, flex: 'none' }}
          />
          <span style={{ color: INK_2, flex: 1 }}>{e.name}</span>
          <span style={{ color: INK, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {fmtUsd(typeof e.value === 'number' ? e.value : 0)}
          </span>
        </div>
      ))}
      {entries.length > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            borderTop: `1px solid ${GRID}`,
            marginTop: 6,
            paddingTop: 6,
          }}
        >
          <span style={{ color: INK_2, fontWeight: 600 }}>Total</span>
          <span style={{ color: INK, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>
            {fmtUsd(total)}
          </span>
        </div>
      )}
    </div>
  );
}

/** Stacked monthly rewards-earned chart, one series per owned card. */
export function EarningsChart({ rows, series }: EarningsChartProps) {
  const keys = series.map((s) => s.key);
  return (
    <div>
      {series.length >= 2 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 10 }}>
          {series.map((s) => (
            <span
              key={s.key}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 600,
                color: INK_2,
              }}
            >
              <span
                style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flex: 'none' }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis
              dataKey="month"
              tickFormatter={monthLabelShort}
              tick={{ fontSize: 11.5, fill: INK_3 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={fmtUsdCompact}
              tick={{ fontSize: 11.5, fill: INK_3 }}
              axisLine={false}
              tickLine={false}
              width={52}
            />
            <Tooltip content={EarningsTip} cursor={{ fill: 'rgba(11, 11, 11, 0.04)' }} />
            {series.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.name}
                stackId="earned"
                fill={s.color}
                barSize={18}
                shape={makeSegment(keys, s.key)}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
