import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useApp } from '../store';
import type { Account, CardProduct } from '../types';
import { CARD_PRODUCTS, productById } from '../data/cards';
import { fmtPct, fmtUsd, fmtUsdWhole } from '../lib/format';
import { isAmbiguousName, matchProduct, suggestionsFor, type CardMatch } from '../lib/cardMatch';
import {
  applyPullResults,
  fetchPlaidStatus,
  fullResync,
  isSyncInProgress,
  syncItem,
  type PlaidItemSummary,
} from '../lib/plaid';
import { ImportWizard } from './accounts/ImportWizard';
import { ConnectBankModal } from './accounts/ConnectBankModal';
import { Modal } from './accounts/Modal';
import { errText, plural, summarizeSync } from './accounts/sync';

type ModalId = 'none' | 'import' | 'connect' | 'resync';

/** A pull in flight. No itemId = every linked bank. */
type Pull = { kind: 'sync' | 'resync'; itemId?: string };

/** The result line under the header. 'busy' is neutral: in progress, or "try again shortly". */
type Feedback = { tone: 'good' | 'bad' | 'busy'; label: string; text: string };

/** Alphabetical for the card-product picker; CARD_PRODUCTS itself stays in curated order. */
const PRODUCT_OPTIONS = [...CARD_PRODUCTS].sort((a, b) => a.name.localeCompare(b.name));

/** Anchor the "Identify cards" button scrolls to. */
const IDENTIFY_ANCHOR = 'identify-cards';

const SMALL_BTN: CSSProperties = { padding: '4px 9px', fontSize: 'var(--fs-xs)', flex: 'none' };

const LINK_BTN: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  font: 'inherit',
  color: 'var(--accent)',
  cursor: 'pointer',
  textDecoration: 'underline',
};

const SUGGESTION_CHIP: CSSProperties = {
  cursor: 'pointer',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
};

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

function isSynced(a: Account): boolean {
  return a.id.startsWith('plaid:');
}

/**
 * True once the backend says this item's history has already been pulled — by
 * this browser or, the case that matters here, by a different one.
 *
 * `hasSyncedOnce` is absent on a backend that predates the field, and a
 * successful pull is also what stamps `lastSync`, so that stands in for it.
 */
function hasSyncedOnce(item: PlaidItemSummary): boolean {
  return item.hasSyncedOnce === true || (item.hasSyncedOnce === undefined && !!item.lastSync);
}

function lastSyncLabel(iso?: string): string {
  if (!iso) return 'never pulled';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never pulled';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 60) return `pulled ${Math.max(mins, 0)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `pulled ${hours}h ago`;
  return `pulled ${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function utilizationBadge(util: number | null): { cls: string; label: string } {
  if (util === null) return { cls: 'badge-neutral', label: 'No limit on file' };
  if (util < 0.1) return { cls: 'badge-good', label: 'Excellent' };
  if (util < 0.3) return { cls: 'badge-warn', label: 'Watch it' };
  return { cls: 'badge-bad', label: 'High' };
}

function utilizationColor(util: number): string {
  if (util < 0.3) return 'var(--accent)';
  if (util < 0.5) return 'var(--warning)';
  return 'var(--critical)';
}

function goToWallet(): void {
  window.location.hash = '/wallet';
}

export default function Accounts() {
  const accounts = useApp((s) => s.accounts);
  const transactions = useApp((s) => s.transactions);
  const removeAccount = useApp((s) => s.removeAccount);
  const updateAccount = useApp((s) => s.updateAccount);
  const applySync = useApp((s) => s.applySync);
  const resetAll = useApp((s) => s.resetAll);

  const [modal, setModal] = useState<ModalId>('none');
  /** Which bank the open Full-resync confirmation covers; null = all of them. */
  const [resyncTarget, setResyncTarget] = useState<PlaidItemSummary | null>(null);

  // Plaid items, if the backend is running and configured. Empty for demo/CSV users.
  const [items, setItems] = useState<PlaidItemSummary[]>([]);
  const [pull, setPull] = useState<Pull | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /** Seconds the running pull has been going, so a long resync never looks stuck. */
  const [elapsed, setElapsed] = useState(0);
  /** A finished pull that brought back nothing at all — one of the two stranded signals. */
  const [emptyPull, setEmptyPull] = useState(false);
  /** A full resync that came back empty: Plaid has nothing, so stop suggesting one. */
  const [resyncCameBackEmpty, setResyncCameBackEmpty] = useState(false);

  // Card identification
  const [identifyMsg, setIdentifyMsg] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(false);

  const busy = pull !== null;

  const refreshItems = useCallback(async () => {
    try {
      const status = await fetchPlaidStatus();
      setItems(status.reachable && status.configured ? status.items : []);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refreshItems();
  }, [refreshItems]);

  // Result lines are transient — they report on an action, not on state. A line
  // about a pull that is still running stays up until the pull ends.
  useEffect(() => {
    if (!feedback || pull) return;
    const t = setTimeout(() => setFeedback(null), 9000);
    return () => clearTimeout(t);
  }, [feedback, pull]);

  useEffect(() => {
    if (!pull) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [pull]);

  useEffect(() => {
    if (!identifyMsg) return;
    const t = setTimeout(() => setIdentifyMsg(null), 12000);
    return () => clearTimeout(t);
  }, [identifyMsg]);

  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(false), 3000);
    return () => clearTimeout(t);
  }, [highlight]);

  const cash = useMemo(() => accounts.filter((a) => a.type !== 'credit'), [accounts]);
  const cards = useMemo(() => accounts.filter((a) => a.type === 'credit'), [accounts]);

  const totalCash = sum(cash.map((a) => a.balance));
  const cardDebt = sum(cards.map((a) => a.balance));
  const totalLimit = sum(cards.map((a) => a.creditLimit ?? 0));
  const utilization = totalLimit > 0 ? cardDebt / totalLimit : null;
  const badge = utilizationBadge(utilization);

  // Name-based product guesses for every card that isn't linked yet. Pure and
  // cheap (a few dozen products), recomputed only when accounts change.
  const matches = useMemo(() => {
    const m = new Map<string, CardMatch | null>();
    for (const a of cards) m.set(a.id, a.productId ? null : matchProduct(a));
    return m;
  }, [cards]);

  const unidentified = useMemo(() => cards.filter((a) => !a.productId), [cards]);
  const confident = useMemo(
    () => unidentified.filter((a) => matches.get(a.id)?.confidence === 'high'),
    [unidentified, matches],
  );

  const txnCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of transactions) m.set(t.accountId, (m.get(t.accountId) ?? 0) + 1);
    return m;
  }, [transactions]);

  // --- Is this browser stranded? -------------------------------------------
  //
  // Access tokens and each item's transactions/sync cursor live on the server,
  // but the accounts and transactions they produce live in THIS browser's
  // localStorage. transactions/sync is incremental: the first pull returns all
  // history and spends the cursor, every later one returns only changes. So a
  // second browser (or one whose site data was cleared, or a phone) sees banks
  // that are still linked and a Sync that keeps coming back empty. Only a full
  // resync — cursors dropped server-side, everything replayed — fixes that.

  const plaidTxnCount = useMemo(
    () => transactions.filter((t) => t.accountId.startsWith('plaid:')).length,
    [transactions],
  );

  /** Each linked item next to what this browser actually holds for it. */
  const linkedBanks = useMemo(
    () =>
      items.map((item) => {
        // Accounts carry the institution name, not the item id — the same match
        // the Connect-bank modal uses to pair an item with its local rows.
        const local = accounts.filter((a) => isSynced(a) && a.institution === item.institutionName);
        return {
          item,
          accountsHere: local.length,
          txnsHere: sum(local.map((a) => txnCounts.get(a.id) ?? 0)),
          syncedOnce: hasSyncedOnce(item),
        };
      }),
    [items, accounts, txnCounts],
  );

  /**
   * Banks are linked, this browser holds no Plaid transactions at all, and
   * either the backend says the history has already been pulled somewhere or a
   * pull we just ran came back with nothing. The "no transactions here" test is
   * what keeps this off a healthy install: a routine Sync with nothing new also
   * adds 0 and 0, and that user must not be told their history is missing.
   */
  const stranded =
    items.length > 0 &&
    plaidTxnCount === 0 &&
    !resyncCameBackEmpty &&
    (linkedBanks.some((b) => b.syncedOnce) || emptyPull);

  /** Banks needing a decision on this page: reconnect, or refill an empty one. */
  const needAttention = useMemo(
    () => linkedBanks.filter((b) => b.item.needsReauth || (b.syncedOnce && b.txnsHere === 0)),
    [linkedBanks],
  );

  /**
   * With one bank and the banner already offering a resync for it, a list
   * repeating the same button is noise. It earns its place when a bank needs
   * reconnecting instead, or when only some of several banks are empty.
   */
  const showBankList =
    needAttention.length > 0 &&
    (!stranded || items.length > 1 || needAttention.some((b) => b.item.needsReauth));

  // --- Pulling -------------------------------------------------------------

  /**
   * Sync and Full resync are the same operation against different endpoints —
   * one code path so the two cannot drift apart in how results reach the store
   * or how the outcome is worded.
   */
  const runPull = async (kind: 'sync' | 'resync', item?: PlaidItemSummary) => {
    const where = item ? ` for ${item.institutionName}` : '';
    setPull({ kind, ...(item ? { itemId: item.itemId } : {}) });
    setFeedback({
      tone: 'busy',
      label: kind === 'resync' ? 'Rebuilding' : 'Syncing',
      text:
        kind === 'resync'
          ? `Re-downloading every transaction Plaid still has${where}. This can take a minute — leave this tab open.`
          : `Pulling what has changed${where}.`,
    });
    if (kind === 'resync') setResyncCameBackEmpty(false);

    try {
      const results = kind === 'resync' ? await fullResync(item?.itemId) : await syncItem(item?.itemId);
      const totals = applyPullResults(results, applySync);
      const summary = summarizeSync(totals);
      // An item that failed in-band still returns 200, so read the totals to
      // decide whether this reads as a success or a problem.
      const allFailed = totals.items > 0 && totals.failures.length === totals.items;
      const broughtNothing =
        totals.items > 0 && totals.failures.length === 0 && totals.accountsAdded === 0 && totals.txnsAdded === 0;

      setEmptyPull(broughtNothing);
      if (kind === 'resync') setResyncCameBackEmpty(broughtNothing && totals.txnsUpdated === 0);

      setFeedback({
        tone: allFailed ? 'bad' : 'good',
        label: allFailed
          ? kind === 'resync'
            ? 'Resync failed'
            : 'Sync failed'
          : kind === 'resync'
            ? 'Resynced'
            : 'Synced',
        text: item ? `${item.institutionName} — ${summary.toLowerCase()}.` : summary,
      });
      await refreshItems();
    } catch (e) {
      // A pull already running is a "wait", not a failure — say what the
      // backend said rather than dressing it up as an error.
      if (isSyncInProgress(e)) {
        setFeedback({
          tone: 'busy',
          label: 'Already running',
          text: errText(e, 'A pull is already running. Give it a moment, then try again.'),
        });
      } else {
        setFeedback({
          tone: 'bad',
          label: kind === 'resync' ? 'Resync failed' : 'Sync failed',
          text: errText(
            e,
            kind === 'resync'
              ? 'Full resync failed. Check that the backend is running.'
              : 'Sync failed. Check that the backend is running.',
          ),
        });
      }
    } finally {
      setPull(null);
    }
  };

  const askResync = (item: PlaidItemSummary | null) => {
    setResyncTarget(item);
    setModal('resync');
  };

  const closeResync = () => {
    setModal('none');
    setResyncTarget(null);
  };

  const confirmResync = () => {
    const target = resyncTarget;
    closeResync();
    void runPull('resync', target ?? undefined);
  };

  const resyncScope = resyncTarget
    ? resyncTarget.institutionName
    : items.length === 1
      ? items[0].institutionName
      : `all ${items.length} linked banks`;

  const onRemove = (a: Account) => {
    const n = txnCounts.get(a.id) ?? 0;
    const synced = isSynced(a)
      ? '\n\nIt comes back on the next sync — use Connect bank → Unlink to disconnect it for good.'
      : '';
    const ok = window.confirm(
      `Remove ${a.name}?\n\nThis also deletes its ${n} transaction${n === 1 ? '' : 's'}. Budgets are kept.${synced}`,
    );
    if (ok) removeAccount(a.id);
  };

  const onReset = () => {
    const ok = window.confirm(
      'Reset all data?\n\nThis clears every account, transaction, and budget, including anything you imported. Finch reloads the demo dataset right after.',
    );
    if (ok) resetAll();
  };

  const onProduct = (a: Account, productId: string) => {
    updateAccount(a.id, { productId: productId || undefined });
  };

  const onIdentifyCards = () => {
    document.getElementById(IDENTIFY_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setHighlight(true);
  };

  const onIdentifyAll = () => {
    let n = 0;
    for (const a of confident) {
      const m = matches.get(a.id);
      if (!m) continue;
      updateAccount(a.id, { productId: m.productId });
      n++;
    }
    if (n > 0) {
      setIdentifyMsg(
        `Identified ${n} card${n === 1 ? '' : 's'} from ${n === 1 ? 'its' : 'their'} name${n === 1 ? '' : 's'}. Rewards, credits and bonus tracking are live for ${n === 1 ? 'it' : 'them'} — use Change below if a guess is wrong.`,
      );
    }
  };

  const closeModal = () => {
    setModal('none');
    void refreshItems();
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Accounts</h1>
          <p className="page-subtitle">
            {accounts.length === 0
              ? 'No accounts yet.'
              : `${accounts.length} account${accounts.length === 1 ? '' : 's'} · ${transactions.length.toLocaleString('en-US')} transactions`}
          </p>
        </div>
        <div className="row">
          <button className="btn btn-ghost btn-danger" onClick={onReset}>
            Reset data
          </button>
          {items.length > 0 && (
            <>
              <button className="btn" onClick={() => void runPull('sync')} disabled={busy}>
                {pull?.kind === 'sync' ? 'Syncing…' : 'Sync'}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => askResync(null)}
                disabled={busy}
                title="Re-download every transaction Plaid still has, ignoring where the last sync left off"
              >
                {pull?.kind === 'resync' ? 'Resyncing…' : 'Full resync'}
              </button>
            </>
          )}
          <button className="btn" onClick={() => setModal('connect')}>
            Connect bank
          </button>
          <button className="btn btn-primary" onClick={() => setModal('import')}>
            Import CSV
          </button>
        </div>
      </div>

      {stranded && (
        <div
          className="banner"
          style={{ marginBottom: 16, justifyContent: 'space-between', gap: 14, alignItems: 'flex-start' }}
        >
          <span>
            Your banks are still linked, but this browser has no transactions. Plaid only sends what's changed since
            the last pull, so a plain Sync comes back empty here. Run a full resync to rebuild the history.
          </span>
          <button className="btn btn-primary" style={{ flex: 'none' }} onClick={() => askResync(null)} disabled={busy}>
            {pull?.kind === 'resync' ? 'Resyncing…' : 'Full resync'}
          </button>
        </div>
      )}

      {showBankList && (
        <section style={{ marginBottom: 16 }}>
          <div className="section-title">Linked banks</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {needAttention.map(({ item, accountsHere, txnsHere }) => (
              <div key={item.itemId} className="card spread" style={{ padding: '12px 14px', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 650 }}>{item.institutionName}</span>
                    {item.needsReauth ? (
                      <span className="badge badge-bad">Reconnect needed</span>
                    ) : (
                      <span className="badge badge-warn">Nothing in this browser</span>
                    )}
                  </div>
                  <div className="small muted">
                    {plural(item.accountCount, 'account')} · {lastSyncLabel(item.lastSync)} ·{' '}
                    {item.needsReauth
                      ? 'Plaid needs you to sign in to this bank again'
                      : accountsHere > 0
                        ? `${plural(txnsHere, 'transaction')} here — a resync brings the history back`
                        : 'no accounts or transactions here yet'}
                  </div>
                </div>
                <div className="row" style={{ flex: 'none', gap: 8 }}>
                  {item.needsReauth ? (
                    // The reconnect flow (Link in update mode) lives in the
                    // Connect-bank modal — send them there rather than
                    // growing a second copy of it.
                    <button
                      className="btn"
                      onClick={() => setModal('connect')}
                      disabled={busy}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      Reconnect
                    </button>
                  ) : (
                    <button
                      className="btn"
                      onClick={() => askResync(item)}
                      disabled={busy}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      {pull?.kind === 'resync' && pull.itemId === item.itemId ? 'Resyncing…' : 'Resync this bank'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {unidentified.length > 0 && (
        <div className="banner" style={{ marginBottom: 16, justifyContent: 'space-between', gap: 14 }}>
          <span>
            {unidentified.length} card{unidentified.length === 1 ? " isn't" : "s aren't"} identified yet — Finch can't
            calculate rewards until they are.
          </span>
          <button className="btn btn-primary" style={{ flex: 'none' }} onClick={onIdentifyCards}>
            Identify cards
          </button>
        </div>
      )}

      {identifyMsg && (
        <div className="row" style={{ gap: 8, marginBottom: 16, alignItems: 'flex-start' }} role="status">
          <span className="badge badge-good" style={{ flex: 'none' }}>
            Identified
          </span>
          <span className="small" style={{ color: 'var(--ink-2)' }}>
            {identifyMsg}
          </span>
        </div>
      )}

      {feedback && (
        <div className="row" style={{ gap: 8, marginBottom: 16, alignItems: 'flex-start' }} role="status">
          <span
            className={`badge ${feedback.tone === 'bad' ? 'badge-bad' : feedback.tone === 'busy' ? 'badge-neutral' : 'badge-good'}`}
            style={{ flex: 'none' }}
          >
            {feedback.label}
          </span>
          <span className="small" style={{ color: feedback.tone === 'bad' ? 'var(--critical)' : 'var(--ink-2)' }}>
            {feedback.text}
            {busy && elapsed >= 3 && <span className="muted tnum"> · {elapsed}s</span>}
          </span>
        </div>
      )}

      <div className="grid-3" style={{ marginBottom: 24 }}>
        <div className="card stat">
          <span className="stat-label">Total cash</span>
          <span className="stat-value tnum">{fmtUsd(totalCash)}</span>
          <span className="stat-delta">
            {cash.length === 0 ? 'No cash accounts' : `Across ${cash.length} account${cash.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <div className="card stat">
          <span className="stat-label">Card debt</span>
          <span className="stat-value tnum">{fmtUsd(cardDebt)}</span>
          <span className="stat-delta">
            {cards.length === 0 ? 'No credit cards' : `Owed on ${cards.length} card${cards.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <div className="card stat">
          <span className="stat-label">Credit utilization</span>
          <span className="row" style={{ gap: 10 }}>
            <span className="stat-value tnum">{utilization === null ? '—' : fmtPct(utilization)}</span>
            <span className={`badge ${badge.cls}`}>{badge.label}</span>
          </span>
          <span className="stat-delta">
            {utilization === null ? 'Add a credit limit to track this' : `${fmtUsd(cardDebt)} used of ${fmtUsdWhole(totalLimit)} in limits`}
          </span>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="big">🏦</div>
            <p style={{ fontWeight: 600, color: 'var(--ink)' }}>Nothing connected yet</p>
            <p className="small" style={{ marginTop: 4 }}>
              {items.length > 0
                ? 'Your banks are linked — a full resync above pulls their history into this browser.'
                : 'Import a CSV statement or load the demo accounts to get started.'}
            </p>
            <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
              <button className="btn" onClick={() => setModal('connect')}>
                Connect bank
              </button>
              <button className="btn btn-primary" onClick={() => setModal('import')}>
                Import CSV
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <AccountGroup
            title="Cash"
            accounts={cash}
            txnCounts={txnCounts}
            matches={matches}
            highlight={false}
            onRemove={onRemove}
            onProduct={onProduct}
            emptyText="No checking or savings accounts."
          />
          <div id={IDENTIFY_ANCHOR} style={{ scrollMarginTop: 16 }}>
            {confident.length > 0 && (
              <div className="row" style={{ gap: 10, marginBottom: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <button className="btn btn-primary" onClick={onIdentifyAll}>
                  Identify all suggested
                </button>
                <span className="small muted">
                  Sets {confident.length} of {unidentified.length} unidentified card
                  {unidentified.length === 1 ? '' : 's'} from a confident name match
                  {confident.length < unidentified.length
                    ? ` — the other ${unidentified.length - confident.length} need${unidentified.length - confident.length === 1 ? 's' : ''} picking by hand.`
                    : '.'}
                </span>
              </div>
            )}
            <AccountGroup
              title="Credit cards"
              accounts={cards}
              txnCounts={txnCounts}
              matches={matches}
              highlight={highlight}
              onRemove={onRemove}
              onProduct={onProduct}
              emptyText="No credit cards."
            />
          </div>
        </>
      )}

      {modal === 'import' && <ImportWizard onClose={() => setModal('none')} />}
      {modal === 'connect' && <ConnectBankModal onClose={closeModal} onImportCsv={() => setModal('import')} />}
      {modal === 'resync' && (
        <Modal
          title="Full resync"
          subtitle={`Rebuild this browser's transaction history from ${resyncScope}.`}
          onClose={closeResync}
          maxWidth={540}
        >
          <div style={{ display: 'grid', gap: 10 }}>
            <p className="small" style={{ color: 'var(--ink-2)', lineHeight: 1.65 }}>
              Finch re-downloads every transaction Plaid still has for {resyncScope} — about two years for most banks.
              A normal Sync only asks for what changed since the last pull, which is why it comes back empty in a
              browser that never received the history.
            </p>
            <p className="small" style={{ color: 'var(--ink-2)', lineHeight: 1.65 }}>
              It does not re-link anything and does not touch your keys: your banks stay connected, you won't be asked
              to sign in again, and nothing is sent anywhere except the request to your own backend. Transactions you
              already have are matched by id and updated in place, so nothing is duplicated and categories you set by
              hand are kept.
            </p>
            <p className="small" style={{ color: 'var(--ink-2)', lineHeight: 1.65 }}>
              It may take a minute. Leave this tab open while it runs.
            </p>
          </div>
          <div className="spread" style={{ marginTop: 18, gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={closeResync}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={confirmResync} disabled={busy}>
              Start full resync
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface GroupProps {
  title: string;
  accounts: Account[];
  txnCounts: Map<string, number>;
  matches: Map<string, CardMatch | null>;
  /** Briefly ring the cards that still need identifying, after "Identify cards". */
  highlight: boolean;
  onRemove: (a: Account) => void;
  onProduct: (a: Account, productId: string) => void;
  emptyText: string;
}

function AccountGroup({ title, accounts, txnCounts, matches, highlight, onRemove, onProduct, emptyText }: GroupProps) {
  return (
    <section style={{ marginBottom: 24 }}>
      <div className="section-title">{title}</div>
      {accounts.length === 0 ? (
        <p className="small muted" style={{ padding: '4px 2px' }}>
          {emptyText}
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              txnCount={txnCounts.get(a.id) ?? 0}
              match={matches.get(a.id) ?? null}
              highlight={highlight}
              onRemove={() => onRemove(a)}
              onProduct={(productId) => onProduct(a, productId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

const TYPE_LABEL: Record<Account['type'], string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit card',
};

function AccountRow({
  account,
  txnCount,
  match,
  highlight,
  onRemove,
  onProduct,
}: {
  account: Account;
  txnCount: number;
  match: CardMatch | null;
  highlight: boolean;
  onRemove: () => void;
  onProduct: (productId: string) => void;
}) {
  const isCredit = account.type === 'credit';
  const limit = account.creditLimit ?? 0;
  const util = isCredit && limit > 0 ? Math.max(0, account.balance) / limit : null;
  const synced = isSynced(account);

  const product = account.productId ? productById(account.productId) : undefined;
  const ambiguous = useMemo(() => isCredit && !account.productId && isAmbiguousName(account), [isCredit, account]);
  const suggestions = useMemo<CardProduct[]>(() => (ambiguous ? suggestionsFor(account, 5) : []), [ambiguous, account]);

  // "Change" on a linked card, "Pick manually" on an unlinked one — both open the full list.
  const [showSelect, setShowSelect] = useState(false);
  const pick = (productId: string) => {
    onProduct(productId);
    setShowSelect(false);
  };

  const needsAttention = isCredit && !account.productId;
  const ring = needsAttention && highlight ? '0 0 0 2px var(--accent)' : undefined;

  const selectEl = (
    <select
      className="select"
      aria-label={`Card product for ${account.name}`}
      value={account.productId ?? ''}
      onChange={(e) => pick(e.target.value)}
      style={{ fontSize: 'var(--fs-xs)', padding: '4px 8px', maxWidth: 260 }}
    >
      <option value="">— not linked —</option>
      {PRODUCT_OPTIONS.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="card spread" style={{ padding: '14px 18px', gap: 16, boxShadow: ring }}>
      <div className="row" style={{ gap: 14, minWidth: 0 }}>
        <div
          aria-hidden
          style={{
            flex: 'none',
            width: 38,
            height: 38,
            borderRadius: 10,
            background: 'var(--surface-2)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
          }}
        >
          {isCredit ? '💳' : account.type === 'savings' ? '🏦' : '💵'}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8, minWidth: 0 }}>
            <span style={{ fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{account.name}</span>
            {synced && <span className="chip" style={{ flex: 'none' }}>Synced from {account.institution}</span>}
          </div>
          <div className="small muted tnum">
            {account.institution} •••• {account.mask} · {TYPE_LABEL[account.type]} · {txnCount.toLocaleString('en-US')} transaction
            {txnCount === 1 ? '' : 's'}
          </div>

          {isCredit && (
            <div style={{ marginTop: 7, display: 'grid', gap: 5 }}>
              {product ? (
                // Identified: show what it is, not a dropdown sitting there forever.
                <>
                  {showSelect ? (
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      {selectEl}
                      <button className="btn btn-ghost" style={SMALL_BTN} onClick={() => setShowSelect(false)}>
                        Done
                      </button>
                    </div>
                  ) : (
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <span className="chip" style={{ flex: 'none' }}>
                        {product.name}
                      </span>
                      <button className="btn btn-ghost" style={SMALL_BTN} onClick={() => setShowSelect(true)}>
                        Change
                      </button>
                    </div>
                  )}
                  <div className="small muted">
                    {product.annualFee > 0 ? `${fmtUsdWhole(product.annualFee)}/yr annual fee` : 'No annual fee'} ·{' '}
                    <button type="button" style={LINK_BTN} onClick={goToWallet}>
                      Set up welcome bonus
                    </button>{' '}
                    — offers change, so only you know the terms you were given.
                  </div>
                </>
              ) : showSelect ? (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {selectEl}
                  <span className="small muted">Pick the exact product to unlock rewards tracking.</span>
                </div>
              ) : match && match.confidence === 'high' ? (
                // Confident name match: one click to accept.
                <>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="chip" style={{ flex: 'none' }}>
                      Looks like {productById(match.productId)?.name ?? match.productId}
                    </span>
                    <button className="btn btn-primary" style={SMALL_BTN} onClick={() => pick(match.productId)}>
                      Yes, that's it
                    </button>
                    <button className="btn btn-ghost" style={SMALL_BTN} onClick={() => setShowSelect(true)}>
                      Pick manually
                    </button>
                  </div>
                  <span className="small muted">{match.why}</span>
                </>
              ) : ambiguous ? (
                // The issuer's label names no product — ask rather than guess.
                <>
                  <span className="small muted">
                    {account.institution} reports this as “{account.name}”, which doesn't name the product — pick which
                    card •••• {account.mask} is.
                  </span>
                  {suggestions.length > 0 && (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {suggestions.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="chip"
                          style={SUGGESTION_CHIP}
                          title={p.annualFee > 0 ? `${p.name} — ${fmtUsdWhole(p.annualFee)}/yr` : `${p.name} — no annual fee`}
                          onClick={() => pick(p.id)}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {selectEl}
                    <span className="small muted">…or find it in the full list.</span>
                  </div>
                </>
              ) : (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {selectEl}
                  <span className="small muted">
                    {match ? `${match.why}.` : 'Link a card product to track rewards, bonuses and credits.'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="row" style={{ gap: 14, flex: 'none' }}>
        <div style={{ textAlign: 'right' }}>
          <div className="tnum" style={{ fontWeight: 700, fontSize: 'var(--fs-md)' }}>
            {fmtUsd(account.balance)}
          </div>
          {isCredit ? (
            util !== null ? (
              <div style={{ marginTop: 4 }}>
                <div className="progress" style={{ width: 150, height: 6, marginLeft: 'auto' }}>
                  <div className="progress-fill" style={{ width: `${Math.min(100, util * 100)}%`, background: utilizationColor(util) }} />
                </div>
                <div className="muted tnum" style={{ fontSize: 'var(--fs-xs)', marginTop: 3 }}>
                  {fmtPct(util)} of {fmtUsdWhole(limit)}
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                Balance owed
              </div>
            )
          ) : (
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              Available
            </div>
          )}
        </div>
        <button className="btn btn-ghost" onClick={onRemove} title={`Remove ${account.name}`} aria-label={`Remove ${account.name}`} style={{ padding: '5px 9px', color: 'var(--ink-3)' }}>
          ✕
        </button>
      </div>
    </div>
  );
}
