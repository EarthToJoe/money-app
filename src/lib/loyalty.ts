import type { LoyaltyProgram, PointsBalance, ProgramKind, TransferPartner } from '../types';
import { partnersTo, programById } from '../data/programs';

// Points engine: balances → value, reachability across transfer partners, and
// a greedy "cheapest cover" planner. All bank currencies in programs.ts move
// to partners in 1,000-point blocks, so transfers are rounded up to the next
// block and capped at the whole blocks the source balance can fund.

export interface BalanceRow {
  program: LoyaltyProgram;
  balance: number;
  valueCents: number;
  updatedAt: string;
  note?: string;
}

export interface ReachableSource {
  fromProgram: LoyaltyProgram;
  fromBalance: number;
  ratio: number;
  /** points of the destination currency this source could contribute */
  yields: number;
  note?: string;
}

export interface Reachability {
  program: LoyaltyProgram;
  own: number;
  /** own + everything transferable from bank balances */
  reachable: number;
  sources: ReachableSource[];
}

/** Bank currencies transfer to partners in whole blocks of this many points. */
export const TRANSFER_BLOCK = 1000;

/** Short display label for a program in step text ("UR", "Hyatt", "MileagePlus"). */
export function programLabel(program: LoyaltyProgram): string {
  const overrides: Record<string, string> = {
    hyatt: 'Hyatt',
    marriott: 'Marriott',
    hilton: 'Hilton',
    ihg: 'IHG',
    wyndham: 'Wyndham',
    choice: 'Choice',
    accor: 'Accor',
    'british-airways': 'British Airways',
    iberia: 'Iberia',
    'capital-one': 'Capital One',
  };
  return overrides[program.id] ?? program.short;
}

/** "1:1", "1:2", "2:1", "1:0.8". */
export function ratioLabel(ratio: number): string {
  if (ratio >= 1) return `1:${trim(ratio)}`;
  const inverse = 1 / ratio;
  if (Math.abs(inverse - Math.round(inverse)) < 1e-9) return `${Math.round(inverse)}:1`;
  return `1:${trim(ratio)}`;
}

function trim(n: number): string {
  return Number(n.toFixed(3)).toString();
}

/** Planning value in cents for a balance in a program. */
function valueOf(program: LoyaltyProgram, balance: number): number {
  return Math.round(balance * program.valueCents);
}

/** Sum balances per program id (a program may appear more than once). */
function balanceMap(balances: PointsBalance[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of balances) {
    if (!Number.isFinite(b.balance) || b.balance <= 0) continue;
    m.set(b.programId, (m.get(b.programId) ?? 0) + Math.floor(b.balance));
  }
  return m;
}

/** Balances joined to program definitions, optionally filtered by kind, sorted by value desc. */
export function balanceRows(balances: PointsBalance[], kind?: ProgramKind): BalanceRow[] {
  const rows: BalanceRow[] = [];
  for (const b of balances) {
    const program = programById(b.programId);
    if (!program) continue;
    if (kind && program.kind !== kind) continue;
    const balance = Number.isFinite(b.balance) ? Math.max(0, Math.floor(b.balance)) : 0;
    const row: BalanceRow = {
      program,
      balance,
      valueCents: valueOf(program, balance),
      updatedAt: b.updatedAt,
    };
    if (b.note) row.note = b.note;
    rows.push(row);
  }
  return rows.sort((a, b) => b.valueCents - a.valueCents || b.balance - a.balance || a.program.name.localeCompare(b.program.name));
}

/** Total planning value (cents) across all balances. */
export function totalValueCents(balances: PointsBalance[]): number {
  let total = 0;
  for (const b of balances) {
    const program = programById(b.programId);
    if (!program || !Number.isFinite(b.balance) || b.balance <= 0) continue;
    total += valueOf(program, Math.floor(b.balance));
  }
  return total;
}

/** How many points of `programId` the user can muster: own balance + transfers from bank programs. */
export function reachability(programId: string, balances: PointsBalance[]): Reachability | null {
  const program = programById(programId);
  if (!program) return null;
  const held = balanceMap(balances);
  const own = held.get(programId) ?? 0;

  const sources: ReachableSource[] = [];
  for (const partner of partnersTo(programId)) {
    const fromProgram = programById(partner.from);
    if (!fromProgram) continue;
    const fromBalance = held.get(partner.from) ?? 0;
    if (fromBalance <= 0) continue;
    const source: ReachableSource = {
      fromProgram,
      fromBalance,
      ratio: partner.ratio,
      yields: Math.floor(fromBalance * partner.ratio),
    };
    if (partner.note) source.note = partner.note;
    sources.push(source);
  }
  sources.sort((a, b) => b.yields - a.yields || a.fromProgram.name.localeCompare(b.fromProgram.name));

  const reachable = own + sources.reduce((sum, s) => sum + s.yields, 0);
  return { program, own, reachable, sources };
}

/**
 * Cheapest way to cover `pointsNeeded` in `programId`: use own balance first, then bank transfers
 * ordered by the cost in cents of source points per destination point (fromProgram.valueCents / ratio).
 * Transfers are rounded up to the nearest 1,000-point block and capped at the whole blocks the
 * source balance can fund. Leftover from rounding is reported in the step's `points` (it is what
 * actually leaves the source account).
 */
export function coverPoints(
  programId: string,
  pointsNeeded: number,
  balances: PointsBalance[],
): { covered: boolean; steps: Array<{ label: string; points: number; fromProgramId: string }>; shortfall: number } {
  const steps: Array<{ label: string; points: number; fromProgramId: string }> = [];
  const need = Number.isFinite(pointsNeeded) ? Math.max(0, Math.ceil(pointsNeeded)) : 0;
  const program = programById(programId);
  if (!program) return { covered: false, steps, shortfall: need };
  if (need === 0) return { covered: true, steps, shortfall: 0 };

  const held = balanceMap(balances);
  let remaining = need;

  // 1. Own balance first — it is already in the right currency and costs nothing to use.
  const own = held.get(programId) ?? 0;
  if (own > 0) {
    const use = Math.min(own, remaining);
    steps.push({
      label: `Use ${fmtPts(use)} ${programLabel(program)} ${program.unit} you already hold`,
      points: use,
      fromProgramId: programId,
    });
    remaining -= use;
  }
  if (remaining === 0) return { covered: true, steps, shortfall: 0 };

  // 2. Bank transfers, cheapest cents-per-destination-point first.
  interface Candidate {
    partner: TransferPartner;
    fromProgram: LoyaltyProgram;
    fromBalance: number;
    costCents: number;
  }
  const candidates: Candidate[] = [];
  for (const partner of partnersTo(programId)) {
    const fromProgram = programById(partner.from);
    const fromBalance = held.get(partner.from) ?? 0;
    if (!fromProgram || fromBalance <= 0 || partner.ratio <= 0) continue;
    candidates.push({ partner, fromProgram, fromBalance, costCents: fromProgram.valueCents / partner.ratio });
  }
  candidates.sort(
      (a, b) =>
        a.costCents - b.costCents ||
        b.fromBalance * b.partner.ratio - a.fromBalance * a.partner.ratio ||
        a.fromProgram.name.localeCompare(b.fromProgram.name),
    );

  for (const c of candidates) {
    if (remaining === 0) break;
    const block = c.fromProgram.kind === 'bank' ? TRANSFER_BLOCK : 1;
    const fundable = Math.floor(c.fromBalance / block) * block; // whole blocks the balance can fund
    if (fundable <= 0) continue;
    const rawNeeded = Math.ceil(remaining / c.partner.ratio);
    const send = Math.min(Math.ceil(rawNeeded / block) * block, fundable);
    if (send <= 0) continue;
    const received = Math.floor(send * c.partner.ratio);
    if (received <= 0) continue;

    steps.push({
      label: `Transfer ${fmtPts(send)} ${programLabel(c.fromProgram)} → ${programLabel(program)} (${ratioLabel(c.partner.ratio)})`,
      points: send,
      fromProgramId: c.fromProgram.id,
    });
    remaining = Math.max(0, remaining - received);
  }

  return { covered: remaining === 0, steps, shortfall: remaining };
}

function fmtPts(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
