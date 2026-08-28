import type { ProgramKind } from '../../types';

/** Local 'YYYY-MM-DD' for today. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days from `fromIso` to `toIso` (calendar-based, DST-safe). */
export function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86_400_000);
}

/** Balances older than this many days get a "stale" badge. */
export const STALE_DAYS = 60;

/** 1 → "1:1", 2 → "1:2", 0.8 → "1:0.8" */
export function fmtRatio(ratio: number): string {
  return `1:${Number(ratio.toFixed(2))}`;
}

export const KIND_LABEL: Record<ProgramKind, string> = {
  bank: 'Bank',
  airline: 'Airline',
  hotel: 'Hotel',
};

export const KIND_PLURAL: Record<ProgramKind, string> = {
  bank: 'bank programs',
  airline: 'airline programs',
  hotel: 'hotel programs',
};

/** Small brand dot used in tables and lists. */
export function ProgramDot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flex: 'none',
      }}
    />
  );
}
