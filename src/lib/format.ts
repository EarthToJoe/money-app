// Formatting helpers used across the app. Always use these instead of
// hand-rolling number formatting, so the UI stays consistent.

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdWhole = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** $1,234.56 */
export function fmtUsd(n: number): string {
  return usd.format(n);
}

/** $1,235 — for stat tiles and axis-adjacent labels */
export function fmtUsdWhole(n: number): string {
  return usdWhole.format(n);
}

/** $1.2k / $340 — for chart axis ticks */
export function fmtUsdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}m`;
  if (abs >= 10_000) return `$${Math.round(n / 1000)}k`;
  if (abs >= 1_000) return `$${(n / 1000).toFixed(1)}k`;
  return usdWhole.format(n);
}

/** Cents → dollars string: 375 → $3.75 */
export function fmtCents(cents: number): string {
  return usd.format(cents / 100);
}

/** 0.42 → 42% */
export function fmtPct(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** 12345 → 12,345 (points balances) */
export function fmtNum(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
}

/** '2026-08-04' → 'Aug 4' */
export function fmtDateShort(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** '2026-08-04' → 'Aug 4, 2026' */
export function fmtDateLong(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
