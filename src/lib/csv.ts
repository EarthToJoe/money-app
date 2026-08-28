import Papa from 'papaparse';
import type { Transaction } from '../types';
import { categorize, looksLikeSpending } from './categorize';

// CSV statement import: parse → guess column mapping → convert to Transactions.

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export interface ColumnMapping {
  dateCol: number;
  descriptionCol: number;
  amountCol: number;
  /** Optional separate credit column (some banks split debit/credit). */
  creditCol?: number;
  /** 'spendPositive': positive amounts are spending. 'spendNegative': negative amounts are spending. */
  sign: 'spendPositive' | 'spendNegative';
}

// ---------------------------------------------------------------------------
// Parsing

export function parseCsvText(text: string): ParsedCsv {
  const cleaned = text.replace(/^\uFEFF/, '');
  const result = Papa.parse<string[]>(cleaned, { header: false, skipEmptyLines: 'greedy' });
  const rows = result.data
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').trim()) : []))
    .filter((r) => r.some((c) => c !== ''));
  if (rows.length === 0) return { headers: [], rows: [] };
  const [headers, ...rest] = rows;
  const width = headers.length;
  const padded = rest.map((r) => {
    if (r.length === width) return r;
    const out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
  return { headers, rows: padded };
}

export async function parseCsvFile(file: File): Promise<ParsedCsv> {
  const text = await file.text();
  return parseCsvText(text);
}

// ---------------------------------------------------------------------------
// Value parsing

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/;
const SLASH_RE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})(?:[T\s].*)?$/;
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function validYmd(y: number, m: number, d: number): string | null {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (d > new Date(y, m, 0).getDate()) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Parse a statement date into 'YYYY-MM-DD'. Returns null if unrecognizable. */
export function parseDate(input: string): string | null {
  const s = input.trim();
  if (!s) return null;

  const iso = ISO_RE.exec(s);
  if (iso) return validYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = SLASH_RE.exec(s);
  if (slash) {
    let y = Number(slash[3]);
    if (slash[3].length === 2) y += y < 70 ? 2000 : 1900;
    return validYmd(y, Number(slash[1]), Number(slash[2]));
  }

  // "Aug 4, 2026", "4 Aug 2026", "August 04 2026"
  const named = /^(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})|(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4}))$/.exec(s);
  if (named) {
    const monName = (named[1] ?? named[5] ?? '').slice(0, 4).toLowerCase();
    const mon = MONTHS[monName] ?? MONTHS[monName.slice(0, 3)];
    const day = Number(named[2] ?? named[4]);
    const year = Number(named[3] ?? named[6]);
    if (mon) return validYmd(year, mon, day);
  }

  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return validYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

/** Parse "$1,234.56", "-12.34", "(12.34)", "12.34 CR" → number. Null if not numeric. */
export function parseAmount(input: string): number | null {
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\bCR\b/i.test(s)) negative = !negative; // "12.34 CR" = credit
  s = s.replace(/[^0-9.\-+]/g, '');
  if (!s || s === '-' || s === '+' || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

// ---------------------------------------------------------------------------
// Mapping heuristics

function findHeader(headers: string[], patterns: RegExp[]): number {
  for (const re of patterns) {
    const idx = headers.findIndex((h) => re.test(h.trim()));
    if (idx >= 0) return idx;
  }
  return -1;
}

function columnScore(parsed: ParsedCsv, col: number, test: (v: string) => boolean): number {
  const sample = parsed.rows.slice(0, 40);
  if (sample.length === 0) return 0;
  let hits = 0;
  for (const r of sample) if (test(r[col] ?? '')) hits++;
  return hits / sample.length;
}

function bestColumn(parsed: ParsedCsv, test: (v: string) => boolean, exclude: number[]): number {
  let best = -1;
  let bestScore = 0;
  for (let c = 0; c < parsed.headers.length; c++) {
    if (exclude.includes(c)) continue;
    const s = columnScore(parsed, c, test);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return bestScore >= 0.5 ? best : -1;
}

/** Best-guess column mapping from headers + sample rows (user can override). */
export function guessMapping(parsed: ParsedCsv): ColumnMapping {
  const headers = parsed.headers;
  const ncols = headers.length;
  const fallback: ColumnMapping = {
    dateCol: 0,
    descriptionCol: Math.min(1, Math.max(0, ncols - 1)),
    amountCol: Math.min(2, Math.max(0, ncols - 1)),
    sign: 'spendPositive',
  };
  if (ncols === 0) return fallback;

  // --- Date column ---------------------------------------------------------
  let dateCol = findHeader(headers, [
    /^(transaction|trans|txn)\s*date$/i,
    /^date$/i,
    /^(posted|post|posting)\s*date$/i,
    /date/i,
    /posted/i,
  ]);
  if (dateCol < 0) dateCol = bestColumn(parsed, (v) => parseDate(v) !== null, []);
  if (dateCol < 0) dateCol = 0;

  // --- Amount / debit / credit ------------------------------------------
  const debitCol = findHeader(headers, [/^debit/i, /debit/i, /withdrawal/i, /money\s*out/i, /outflow/i]);
  const creditColRaw = findHeader(headers, [/^credit$/i, /^credit\s*amount$/i, /deposit/i, /money\s*in/i, /inflow/i, /credit/i]);
  let amountCol = findHeader(headers, [/^amount$/i, /^(transaction|txn)\s*amount$/i, /amount/i, /^total$/i]);

  let creditCol: number | undefined;
  let debitNamed = false;
  if (amountCol < 0 && debitCol >= 0) {
    amountCol = debitCol;
    debitNamed = true;
    if (creditColRaw >= 0 && creditColRaw !== debitCol) creditCol = creditColRaw;
  } else if (
    amountCol >= 0 &&
    debitCol >= 0 &&
    creditColRaw >= 0 &&
    debitCol !== amountCol &&
    creditColRaw !== amountCol &&
    debitCol !== creditColRaw
  ) {
    // Both a debit and a credit column exist alongside something called "amount" — prefer the split pair.
    amountCol = debitCol;
    debitNamed = true;
    creditCol = creditColRaw;
  } else if (amountCol >= 0 && /debit|withdrawal/i.test(headers[amountCol])) {
    debitNamed = true;
  }
  if (amountCol < 0) {
    amountCol = bestColumn(parsed, (v) => parseAmount(v) !== null && !/^\d{1,2}[/\-.]\d{1,2}/.test(v), [dateCol]);
  }
  if (amountCol < 0) amountCol = fallback.amountCol;

  // --- Description ---------------------------------------------------------
  let descriptionCol = findHeader(headers, [
    /^description$/i,
    /^(merchant|payee|name)$/i,
    /description/i,
    /merchant/i,
    /payee/i,
    /^name$/i,
    /memo/i,
    /details?/i,
    /narrative/i,
  ]);
  if (descriptionCol < 0 || descriptionCol === dateCol || descriptionCol === amountCol) {
    // Longest-average-text column that isn't date/amount.
    let best = -1;
    let bestLen = 0;
    for (let c = 0; c < ncols; c++) {
      if (c === dateCol || c === amountCol || c === creditCol) continue;
      const sample = parsed.rows.slice(0, 40);
      const avg = sample.reduce((a, r) => a + (r[c] ?? '').length, 0) / Math.max(1, sample.length);
      if (avg > bestLen) {
        best = c;
        bestLen = avg;
      }
    }
    descriptionCol = best >= 0 ? best : fallback.descriptionCol;
  }

  // --- Sign heuristic --------------------------------------------------------
  let sign: ColumnMapping['sign'] = 'spendPositive';
  if (debitNamed || creditCol !== undefined) {
    sign = 'spendPositive';
  } else {
    const sample = parsed.rows.slice(0, 200);
    let pos = 0;
    let neg = 0;
    let spendPos = 0;
    let spendNeg = 0;
    for (const r of sample) {
      const n = parseAmount(r[amountCol] ?? '');
      if (n === null || n === 0) continue;
      if (n > 0) pos++;
      else neg++;
      if (looksLikeSpending(r[descriptionCol] ?? '')) {
        if (n > 0) spendPos++;
        else spendNeg++;
      }
    }
    if (spendPos + spendNeg > 0) {
      sign = spendNeg > spendPos ? 'spendNegative' : 'spendPositive';
    } else {
      sign = neg > pos ? 'spendNegative' : 'spendPositive';
    }
  }

  return creditCol !== undefined
    ? { dateCol, descriptionCol, amountCol, creditCol, sign }
    : { dateCol, descriptionCol, amountCol, sign };
}

// ---------------------------------------------------------------------------
// Conversion

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `csv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Convert parsed rows to transactions (normalized merchant + auto category). Invalid rows are skipped. */
export function rowsToTransactions(
  parsed: ParsedCsv,
  mapping: ColumnMapping,
  accountId: string,
): Transaction[] {
  const out: Transaction[] = [];
  for (const row of parsed.rows) {
    const date = parseDate(row[mapping.dateCol] ?? '');
    if (!date) continue;

    const rawDescription = (row[mapping.descriptionCol] ?? '').trim();
    if (!rawDescription) continue;

    let amount: number | null = null;
    if (mapping.creditCol !== undefined && mapping.creditCol !== mapping.amountCol) {
      // Split debit/credit columns: both are treated as magnitudes.
      const debit = parseAmount(row[mapping.amountCol] ?? '');
      const credit = parseAmount(row[mapping.creditCol] ?? '');
      if (debit !== null && debit !== 0) amount = Math.abs(debit);
      else if (credit !== null && credit !== 0) amount = -Math.abs(credit);
      else if (debit === 0 || credit === 0) amount = 0;
    } else {
      const n = parseAmount(row[mapping.amountCol] ?? '');
      if (n !== null) amount = mapping.sign === 'spendPositive' ? n : -n;
    }
    if (amount === null || !Number.isFinite(amount)) continue;
    amount = Math.round(amount * 100) / 100;
    if (Object.is(amount, -0)) amount = 0;

    const { merchant, category } = categorize(rawDescription);
    out.push({
      id: newId(),
      accountId,
      date,
      merchant: merchant || rawDescription,
      rawDescription,
      amount,
      category,
      source: 'csv',
    });
  }
  return out;
}
