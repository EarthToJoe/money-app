import { Fragment, useEffect, useMemo, useState, type ChangeEvent, type CSSProperties } from 'react';
import { useApp } from '../../store';
import type { Account, AccountType, Transaction } from '../../types';
import { guessMapping, parseCsvFile, parseCsvText, rowsToTransactions, type ColumnMapping, type ParsedCsv } from '../../lib/csv';
import { fmtDateShort, fmtUsd } from '../../lib/format';
import { CategoryChip } from '../../components/CategoryChip';
import { Modal } from './Modal';
import { SAMPLE_CSV_NAME, buildSampleCsv } from './sampleCsv';

interface Props {
  onClose: () => void;
}

type Step = 1 | 2 | 3;
type TargetMode = 'existing' | 'new';

const STEPS: Array<{ n: Step; label: string }> = [
  { n: 1, label: 'Account' },
  { n: 2, label: 'File & mapping' },
  { n: 3, label: 'Import' },
];

const ACCOUNT_TYPES: Array<{ value: AccountType; label: string }> = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit', label: 'Credit card' },
];

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `acct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function columnLabel(headers: string[], i: number): string {
  const h = headers[i]?.trim();
  return h ? h : `Column ${i + 1}`;
}

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 'var(--fs-xs)',
  fontWeight: 600,
  color: 'var(--ink-3)',
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  marginBottom: 4,
};

// ---------------------------------------------------------------------------

export function ImportWizard({ onClose }: Props) {
  const accounts = useApp((s) => s.accounts);
  const addAccount = useApp((s) => s.addAccount);
  const addTransactions = useApp((s) => s.addTransactions);

  const [step, setStep] = useState<Step>(1);

  // Step 1 — target account
  const [mode, setMode] = useState<TargetMode>(accounts.length > 0 ? 'existing' : 'new');
  const [existingId, setExistingId] = useState<string>(accounts[0]?.id ?? '');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<AccountType>('checking');

  // Step 2 — file + mapping
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 3 — result
  const [result, setResult] = useState<{ attempted: number; added: number } | null>(null);

  useEffect(() => {
    if (mode === 'existing' && !accounts.some((a) => a.id === existingId)) {
      setExistingId(accounts[0]?.id ?? '');
    }
  }, [accounts, existingId, mode]);

  const targetAccount: Account | undefined = mode === 'existing' ? accounts.find((a) => a.id === existingId) : undefined;
  const targetLabel = mode === 'existing' ? targetAccount?.name ?? '' : newName.trim();
  const step1Valid = mode === 'existing' ? Boolean(targetAccount) : newName.trim().length > 0;

  const previewTxns: Transaction[] = useMemo(() => {
    if (!parsed || !mapping) return [];
    return rowsToTransactions(parsed, mapping, targetAccount?.id ?? 'preview');
  }, [parsed, mapping, targetAccount?.id]);

  const applyParsed = (p: ParsedCsv, name: string) => {
    setParsed(p);
    setFileName(name);
    setResult(null);
    if (p.headers.length === 0 || p.rows.length === 0) {
      setMapping(null);
      setParseError('No rows found in that file. Check that it is a CSV with a header row.');
      return;
    }
    setParseError(null);
    setMapping(guessMapping(p));
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const p = await parseCsvFile(file);
      applyParsed(p, file.name);
    } catch (err) {
      setParsed(null);
      setMapping(null);
      setParseError(err instanceof Error ? err.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  };

  const useSample = () => {
    applyParsed(parseCsvText(buildSampleCsv()), SAMPLE_CSV_NAME);
  };

  const updateMapping = (patch: Partial<ColumnMapping>) => {
    setMapping((m) => {
      if (!m) return m;
      const next: ColumnMapping = { ...m, ...patch };
      if (patch.creditCol === undefined && 'creditCol' in patch) delete next.creditCol;
      return next;
    });
  };

  const runImport = () => {
    if (!parsed || !mapping) return;
    let accountId = targetAccount?.id ?? '';
    if (mode === 'new') {
      const account: Account = {
        id: newId(),
        name: newName.trim(),
        institution: 'Imported',
        type: newType,
        mask: '0000',
        balance: 0,
        createdAt: new Date().toISOString(),
      };
      addAccount(account);
      accountId = account.id;
    }
    if (!accountId) return;
    const txns = rowsToTransactions(parsed, mapping, accountId);
    const added = addTransactions(txns);
    setResult({ attempted: txns.length, added });
  };

  const skippedRows = parsed ? parsed.rows.length - previewTxns.length : 0;

  return (
    <Modal title="Import CSV" subtitle="Bring in a statement export from your bank" onClose={onClose} maxWidth={760}>
      <StepIndicator step={step} />

      {step === 1 && (
        <div>
          <div className="segmented" style={{ marginBottom: 16 }}>
            <button className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')} disabled={accounts.length === 0}>
              Existing account
            </button>
            <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>
              New account
            </button>
          </div>

          {mode === 'existing' ? (
            <div>
              <label style={labelStyle} htmlFor="import-target">
                Import into
              </label>
              <select id="import-target" className="select" value={existingId} onChange={(e) => setExistingId(e.target.value)} style={{ width: '100%' }}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.institution} •••• {a.mask}
                  </option>
                ))}
              </select>
              <p className="small muted" style={{ marginTop: 8 }}>
                Rows that already exist in this account (same date, amount, and description) are skipped.
              </p>
            </div>
          ) : (
            <div className="grid-2" style={{ gap: 12 }}>
              <div>
                <label style={labelStyle} htmlFor="import-new-name">
                  Account name
                </label>
                <input
                  id="import-new-name"
                  className="input"
                  placeholder="e.g. Capital One Venture"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  style={{ width: '100%' }}
                  autoFocus
                />
              </div>
              <div>
                <label style={labelStyle} htmlFor="import-new-type">
                  Type
                </label>
                <select id="import-new-type" className="select" value={newType} onChange={(e) => setNewType(e.target.value as AccountType)} style={{ width: '100%' }}>
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="small muted" style={{ gridColumn: '1 / -1', margin: 0 }}>
                The account is created when you import, with a $0.00 starting balance you can reconcile later.
              </p>
            </div>
          )}

          <div className="spread" style={{ marginTop: 22 }}>
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!step1Valid} onClick={() => setStep(2)}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <input type="file" accept=".csv,text/csv" className="input" onChange={onFile} disabled={busy} style={{ flex: 1, minWidth: 240 }} />
            <button className="btn btn-ghost" onClick={useSample} disabled={busy}>
              Use sample data
            </button>
          </div>

          {parseError && (
            <div className="banner" style={{ marginTop: 12, color: 'var(--critical)', background: 'rgba(208, 59, 59, 0.08)', borderColor: 'rgba(208, 59, 59, 0.25)' }}>
              {parseError}
            </div>
          )}

          {parsed && mapping && parsed.rows.length > 0 && (
            <>
              <div className="spread" style={{ marginTop: 18, marginBottom: 8 }}>
                <div className="section-title" style={{ margin: 0 }}>
                  File preview
                </div>
                <span className="small muted tnum">
                  {fileName} · {parsed.rows.length} rows
                </span>
              </div>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
                <table className="table" style={{ fontSize: 'var(--fs-xs)', whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr>
                      {parsed.headers.map((h, i) => (
                        <th key={i} style={{ fontWeight: 700, color: 'var(--ink)', textTransform: 'none', letterSpacing: 0 }}>
                          {columnLabel(parsed.headers, i)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, 6).map((r, ri) => (
                      <tr key={ri}>
                        {parsed.headers.map((_h, ci) => (
                          <td key={ci} style={{ padding: '6px 10px', color: 'var(--ink-2)' }}>
                            {r[ci] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="section-title" style={{ marginTop: 18 }}>
                Column mapping
              </div>
              <div className="grid-4" style={{ gap: 10 }}>
                <ColumnSelect id="map-date" label="Date" headers={parsed.headers} value={mapping.dateCol} onChange={(v) => updateMapping({ dateCol: v })} />
                <ColumnSelect id="map-desc" label="Description" headers={parsed.headers} value={mapping.descriptionCol} onChange={(v) => updateMapping({ descriptionCol: v })} />
                <ColumnSelect
                  id="map-amount"
                  label={mapping.creditCol !== undefined ? 'Debit' : 'Amount'}
                  headers={parsed.headers}
                  value={mapping.amountCol}
                  onChange={(v) => updateMapping({ amountCol: v })}
                />
                <ColumnSelect
                  id="map-credit"
                  label="Credit (optional)"
                  headers={parsed.headers}
                  value={mapping.creditCol ?? -1}
                  allowNone
                  onChange={(v) => updateMapping({ creditCol: v < 0 ? undefined : v })}
                />
              </div>
              <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                <div className="segmented">
                  <button className={mapping.sign === 'spendPositive' ? 'active' : ''} onClick={() => updateMapping({ sign: 'spendPositive' })} disabled={mapping.creditCol !== undefined}>
                    Spending is positive
                  </button>
                  <button className={mapping.sign === 'spendNegative' ? 'active' : ''} onClick={() => updateMapping({ sign: 'spendNegative' })} disabled={mapping.creditCol !== undefined}>
                    Spending is negative
                  </button>
                </div>
                <span className="small muted">
                  {mapping.creditCol !== undefined ? 'With separate debit and credit columns, both are read as magnitudes.' : 'Flip this if purchases below show as money in.'}
                </span>
              </div>

              <div className="spread" style={{ marginTop: 18, marginBottom: 8 }}>
                <div className="section-title" style={{ margin: 0 }}>
                  Converted preview
                </div>
                <span className="small muted tnum">
                  {previewTxns.length} of {parsed.rows.length} rows readable
                  {skippedRows > 0 ? ` · ${skippedRows} skipped` : ''}
                </span>
              </div>
              {previewTxns.length === 0 ? (
                <div className="empty-state" style={{ padding: '24px 16px' }}>
                  <p className="small">No rows could be converted with this mapping. Check the date and amount columns.</p>
                </div>
              ) : (
                <TxnPreview txns={previewTxns.slice(0, 5)} />
              )}
            </>
          )}

          {!parsed && !parseError && (
            <div className="empty-state" style={{ padding: '32px 16px' }}>
              <div className="big">📄</div>
              <p className="small">Choose a CSV export from your bank, or load the sample to see how mapping works.</p>
            </div>
          )}

          <div className="spread" style={{ marginTop: 22 }}>
            <button className="btn btn-ghost" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn btn-primary" disabled={previewTxns.length === 0} onClick={() => setStep(3)}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          {result ? (
            <div className="empty-state" style={{ padding: '28px 16px' }}>
              <div className="big">✅</div>
              <p style={{ fontWeight: 650, color: 'var(--ink)' }}>
                Imported {result.added} transaction{result.added === 1 ? '' : 's'}
                {result.attempted - result.added > 0 ? ` (${result.attempted - result.added} duplicate${result.attempted - result.added === 1 ? '' : 's'} skipped)` : ''}
              </p>
              <p className="small" style={{ marginTop: 4 }}>
                Added to {targetLabel}. Categories are editable on the Transactions page.
              </p>
            </div>
          ) : (
            <div>
              <div className="card" style={{ padding: '14px 16px', boxShadow: 'none' }}>
                <SummaryRow label="Into" value={mode === 'new' ? `${targetLabel} (new ${ACCOUNT_TYPES.find((t) => t.value === newType)?.label.toLowerCase() ?? ''} account)` : `${targetLabel} — ${targetAccount?.institution ?? ''} •••• ${targetAccount?.mask ?? ''}`} />
                <SummaryRow label="File" value={`${fileName ?? ''} · ${parsed?.rows.length ?? 0} rows`} />
                <SummaryRow label="Ready" value={`${previewTxns.length} transaction${previewTxns.length === 1 ? '' : 's'}${skippedRows > 0 ? ` · ${skippedRows} unreadable row${skippedRows === 1 ? '' : 's'} skipped` : ''}`} />
                <SummaryRow label="Money out" value={fmtUsd(previewTxns.reduce((a, t) => a + Math.max(0, t.amount), 0))} />
                <SummaryRow label="Money in" value={fmtUsd(previewTxns.reduce((a, t) => a + Math.max(0, -t.amount), 0))} last />
              </div>
              <p className="small muted" style={{ marginTop: 10 }}>
                Duplicates already in the account are skipped automatically.
              </p>
            </div>
          )}

          <div className="spread" style={{ marginTop: 22 }}>
            {result ? (
              <>
                <span />
                <button className="btn btn-primary" onClick={onClose}>
                  Done
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-ghost" onClick={() => setStep(2)}>
                  Back
                </button>
                <button className="btn btn-primary" onClick={runImport} disabled={previewTxns.length === 0}>
                  Import {previewTxns.length} transaction{previewTxns.length === 1 ? '' : 's'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function StepIndicator({ step }: { step: Step }) {
  return (
    <div className="row" style={{ gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
      {STEPS.map((s, i) => {
        const state = s.n === step ? 'active' : s.n < step ? 'done' : 'todo';
        return (
          <Fragment key={s.n}>
            {i > 0 && <span style={{ width: 18, height: 1, background: 'var(--grid)' }} />}
            <span className="row" style={{ gap: 7 }}>
              <span
                className="tnum"
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  background: state === 'todo' ? 'var(--surface-2)' : 'var(--ink)',
                  color: state === 'todo' ? 'var(--ink-3)' : 'var(--surface)',
                }}
              >
                {state === 'done' ? '✓' : s.n}
              </span>
              <span className="small" style={{ fontWeight: state === 'active' ? 650 : 500, color: state === 'active' ? 'var(--ink)' : 'var(--ink-3)' }}>
                {s.label}
              </span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

interface ColumnSelectProps {
  id: string;
  label: string;
  headers: string[];
  value: number;
  allowNone?: boolean;
  onChange: (v: number) => void;
}

function ColumnSelect({ id, label, headers, value, allowNone, onChange }: ColumnSelectProps) {
  return (
    <div>
      <label style={labelStyle} htmlFor={id}>
        {label}
      </label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%' }}>
        {allowNone && <option value={-1}>None</option>}
        {headers.map((_h, i) => (
          <option key={i} value={i}>
            {columnLabel(headers, i)}
          </option>
        ))}
      </select>
    </div>
  );
}

function TxnPreview({ txns }: { txns: Transaction[] }) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Merchant</th>
              <th>Category</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id}>
                <td className="tnum" style={{ whiteSpace: 'nowrap' }}>{fmtDateShort(t.date)}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{t.merchant}</div>
                  <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{t.rawDescription}</div>
                </td>
                <td>
                  <CategoryChip id={t.category} />
                </td>
                <td className="num" style={{ fontWeight: 600, color: t.amount < 0 ? 'var(--good-text)' : 'var(--ink)' }}>
                  {t.amount < 0 ? `+${fmtUsd(-t.amount)}` : fmtUsd(t.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div className="spread small" style={{ padding: '7px 0', borderBottom: last ? 0 : '1px solid var(--grid)', gap: 16 }}>
      <span className="muted" style={{ flex: 'none' }}>
        {label}
      </span>
      <span className="tnum" style={{ fontWeight: 600, textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}
