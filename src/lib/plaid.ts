import type { Account, CategoryId, Transaction } from '../types';
import { categorize } from './categorize';
import { todayIso } from './credits';

// Browser-side Plaid client.
//
// The browser never sees a Plaid access token. It calls our own backend
// (server/index.js) over /api/plaid/*, which holds the secret, stores the
// access tokens, and tracks each item's transactions/sync cursor.
//
// Backend contract this module speaks (all same-origin, JSON in / JSON out,
// proxied to http://localhost:8787 by vite.config.ts):
//
//   GET    /api/plaid/status              -> PlaidStatus
//   POST   /api/plaid/credentials         { clientId, secret, env, redirectUri? }
//                                         -> { ok, env, clientIdTail, secretTail, savedTo }
//   POST   /api/plaid/redirect-uri        { redirectUri }  -> { ok, redirectUri }
//   POST   /api/plaid/link-token          { itemId? }  -> { linkToken }
//   POST   /api/plaid/exchange            { publicToken }
//                                         -> { itemId, institutionName, accounts }
//   POST   /api/plaid/sync                { itemId? }  -> SyncResult[]
//   POST   /api/plaid/resync              { itemId? }  -> SyncResult[]
//   DELETE /api/plaid/item/:itemId        -> { removed: true }
//
// /sync and /resync answer with the same shape and differ in one thing: /sync
// resumes from each item's stored transactions/sync cursor, while /resync drops
// the cursor first so Plaid replays every transaction it still has. That replay
// is the only way a second browser (or a browser whose site data was cleared)
// can ever get the history — the cursor is spent the moment the first browser
// pulls it. A resync refused because one is already running comes back 409
// with code SYNC_IN_PROGRESS.
//
// Errors come back as { error: { code, message } } with a non-2xx status.

// --- Wire DTOs returned by the backend (plain JSON, not our domain types) ---

export interface PlaidAccountDto {
  accountId: string; // Plaid account_id — stable, used to build our Account.id
  name: string;
  officialName?: string;
  mask: string;
  type: string; // 'depository' | 'credit' | ...
  subtype?: string; // 'checking' | 'savings' | 'credit card' | ...
  balanceCurrent: number;
  balanceAvailable?: number;
  creditLimit?: number;
  institutionName: string;
  itemId: string;
}

export interface PlaidTransactionDto {
  transactionId: string;
  accountId: string;
  date: string; // 'YYYY-MM-DD'
  name: string; // raw description
  merchantName?: string; // Plaid's cleaned merchant, when it has one
  amount: number; // Plaid sign: positive = money out of the account
  pending: boolean;
  /** Plaid personal_finance_category, e.g. { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' } */
  pfcPrimary?: string;
  pfcDetailed?: string;
}

export interface PlaidItemSummary {
  itemId: string;
  institutionName: string;
  accountCount: number;
  lastSync?: string; // ISO timestamp
  /** set when Plaid needs the user to re-authenticate this item */
  needsReauth?: boolean;
  /**
   * True once this item has completed at least one transactions/sync pull —
   * i.e. its history has already been handed to *some* browser. Combined with
   * "this browser holds nothing for it", that is the stranded state a full
   * resync exists to repair. Absent on backends that predate the field.
   */
  hasSyncedOnce?: boolean;
}

export interface PlaidStatus {
  /** true once PLAID_CLIENT_ID and PLAID_SECRET are set in .env */
  configured: boolean;
  /** false when the backend isn't running at all */
  reachable: boolean;
  env: 'sandbox' | 'production' | 'unknown';
  items: PlaidItemSummary[];
  message?: string;
  /**
   * Last 5 characters of the saved client_id / secret, so the UI can confirm
   * *which* keys are in use without ever handling the values themselves.
   * Present only when configured — the backend never sends the full secret.
   */
  clientIdTail?: string;
  secretTail?: string;
  /**
   * The OAuth redirect URL the backend puts in every link token, e.g.
   * "https://calm-otter-1234.trycloudflare.com/oauth". Empty/absent when none
   * is configured — which is fine in Sandbox but blocks every OAuth bank
   * (Chase, Capital One, Bank of America, …) in Production.
   */
  redirectUri?: string;
}

export interface SyncResult {
  accounts: PlaidAccountDto[];
  added: PlaidTransactionDto[];
  modified: PlaidTransactionDto[];
  removed: string[]; // Plaid transaction ids
  itemId: string;
  /**
   * One item failing doesn't fail the batch: the backend answers 200 with the
   * failure recorded here and empty arrays, so the other banks still sync.
   */
  error?: { code?: string; message: string };
  /** Plaid locked this item out — the user has to reconnect it through Link update mode. */
  needsReauth?: boolean;
}

// --- HTTP plumbing ---------------------------------------------------------

const API_BASE = '/api/plaid';

/** Exported so the UI can tell "backend down" apart from a message worth showing verbatim. */
export const BACKEND_DOWN =
  "The Plaid backend isn't running. Start it with `npm run dev` (that runs the API server on port 8787 alongside the web app).";

/** The backend already had a pull running for this item. Not a failure — just "wait". */
export const SYNC_IN_PROGRESS_CODE = 'SYNC_IN_PROGRESS';

/** Only used when the backend sends the code with no message of its own. */
const SYNC_IN_PROGRESS_FALLBACK =
  'A pull is already running for this bank. Give it a moment, then try again.';

/**
 * A failed backend call, carrying the backend's own `error.code` alongside its
 * message so callers can tell "already running" (worth waiting out) apart from
 * a real failure. Still a plain Error: everything that only reads `.message`
 * keeps working unchanged.
 */
export class PlaidRequestError extends Error {
  /** HTTP status, or 0 when the request never reached the backend. */
  readonly status: number;
  /** Machine-readable code from { error: { code } }; '' when the backend sent none. */
  readonly code: string;

  constructor(message: string, status = 0, code = '') {
    super(message);
    this.name = 'PlaidRequestError';
    this.status = status;
    this.code = code;
  }
}

/** True when this failure is the backend saying a pull is already under way. */
export function isSyncInProgress(err: unknown): boolean {
  if (!(err instanceof PlaidRequestError)) return false;
  return err.code === SYNC_IN_PROGRESS_CODE || (err.status === 409 && err.code === '');
}

/** Pull a useful message and code out of whatever the backend sent back. */
function parseError(body: string, status: number): { message: string | null; code: string } {
  // Vite's proxy answers an empty-bodied 5xx when nothing is listening on 8787.
  if (!body.trim()) return { message: status >= 500 ? BACKEND_DOWN : null, code: '' };
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const err = (parsed as { error?: unknown }).error;
      if (typeof err === 'string' && err.trim()) return { message: err.trim(), code: '' };
      if (err && typeof err === 'object') {
        const rawCode = (err as { code?: unknown }).code;
        const code = typeof rawCode === 'string' ? rawCode.trim() : '';
        const msg = (err as { message?: unknown }).message;
        if (typeof msg === 'string' && msg.trim()) return { message: msg.trim(), code };
        return { message: null, code };
      }
      const top = (parsed as { message?: unknown }).message;
      if (typeof top === 'string' && top.trim()) return { message: top.trim(), code: '' };
    }
  } catch {
    // Not JSON. A 5xx with an HTML/empty body is what vite's proxy returns when
    // nothing is listening on 8787, so treat that as "backend down" too.
    if (status >= 500) return { message: BACKEND_DOWN, code: '' };
  }
  return { message: null, code: '' };
}

async function api<T>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'DELETE'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    // fetch only rejects on a transport failure — the server isn't there.
    throw new PlaidRequestError(BACKEND_DOWN);
  }

  const text = await res.text().catch(() => '');

  if (!res.ok) {
    const { message, code } = parseError(text, res.status);
    const fallback =
      code === SYNC_IN_PROGRESS_CODE
        ? SYNC_IN_PROGRESS_FALLBACK
        : `Plaid request failed (${res.status}).`;
    throw new PlaidRequestError(message ?? fallback, res.status, code);
  }

  if (!text.trim()) return undefined as T; // 204 No Content
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PlaidRequestError('The Plaid backend returned a response we could not read.', res.status);
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Could not reach the Plaid backend.';
}

// --- Backend calls ---------------------------------------------------------

/**
 * One entry of status.items, defensively read. Anything the backend leaves out
 * simply stays absent rather than arriving as a wrong-typed value the UI then
 * has to second-guess.
 */
function toItemSummary(raw: unknown): PlaidItemSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PlaidItemSummary>;
  const itemId = typeof r.itemId === 'string' ? r.itemId.trim() : '';
  if (!itemId) return null;
  const name = typeof r.institutionName === 'string' ? r.institutionName.trim() : '';
  const count = typeof r.accountCount === 'number' && Number.isFinite(r.accountCount) ? r.accountCount : 0;
  return {
    itemId,
    institutionName: name || 'Bank',
    accountCount: count,
    ...(typeof r.lastSync === 'string' && r.lastSync.trim() ? { lastSync: r.lastSync } : {}),
    ...(r.needsReauth === true ? { needsReauth: true } : {}),
    ...(r.hasSyncedOnce === true ? { hasSyncedOnce: true } : {}),
  };
}

export async function fetchPlaidStatus(): Promise<PlaidStatus> {
  try {
    const raw = await api<Partial<PlaidStatus> | null>('/status');
    if (!raw || typeof raw !== 'object') {
      return {
        configured: false,
        reachable: false,
        env: 'unknown',
        items: [],
        message: 'The Plaid backend returned an unexpected status response.',
      };
    }
    return {
      configured: raw.configured === true,
      // We got a real response, so the backend is up whatever else it says.
      reachable: true,
      env: raw.env === 'sandbox' || raw.env === 'production' ? raw.env : 'unknown',
      items: Array.isArray(raw.items)
        ? raw.items.map(toItemSummary).filter((i): i is PlaidItemSummary => i !== null)
        : [],
      ...(typeof raw.message === 'string' && raw.message ? { message: raw.message } : {}),
      ...(typeof raw.clientIdTail === 'string' && raw.clientIdTail
        ? { clientIdTail: raw.clientIdTail }
        : {}),
      ...(typeof raw.secretTail === 'string' && raw.secretTail
        ? { secretTail: raw.secretTail }
        : {}),
      ...(typeof raw.redirectUri === 'string' && raw.redirectUri.trim()
        ? { redirectUri: raw.redirectUri.trim() }
        : {}),
    };
  } catch (err) {
    // Contract: this never throws — the UI renders the reason instead.
    return {
      configured: false,
      reachable: false,
      env: 'unknown',
      items: [],
      message: messageOf(err),
    };
  }
}

/**
 * Hand the user's Plaid API keys to the LOCAL backend, which verifies them
 * against Plaid, writes them to .env and reloads its Plaid client in-process.
 * No dev-server restart, and no file editing by hand.
 *
 * The secret travels in the POST body and nowhere else: never a query string,
 * never console, never localStorage or the zustand store. The only thing that
 * comes back is the last few characters of each key, for a confirmation line.
 *
 * Throws with the backend's own message on failure (bad shape, keys rejected
 * by Plaid, or a non-local caller) so the UI can render it verbatim.
 */
export async function saveCredentials(input: {
  clientId: string;
  secret: string;
  env: 'sandbox' | 'production';
  /**
   * OAuth redirect URL, e.g. "https://<tunnel-host>/oauth". Optional, and only
   * meaningful in Production: it goes into every link token, and the exact
   * same string must be registered in the Plaid dashboard under
   * Developers → API → Allowed redirect URIs.
   */
  redirectUri?: string;
}): Promise<{ env: string; clientIdTail: string; secretTail: string }> {
  const res = await api<{
    ok?: boolean;
    env?: string;
    clientIdTail?: string;
    secretTail?: string;
    savedTo?: string;
  } | null>('/credentials', {
    clientId: input.clientId,
    secret: input.secret,
    env: input.env,
    // Omitted rather than sent empty: an absent field leaves whatever the
    // backend already has, which is what "I didn't touch this" should mean.
    ...(input.redirectUri && input.redirectUri.trim()
      ? { redirectUri: input.redirectUri.trim() }
      : {}),
  });

  // A 2xx that doesn't say ok:true isn't the contract — don't claim success.
  if (!res || res.ok !== true) {
    throw new Error('The Plaid backend did not confirm the keys were saved. Try again.');
  }

  return {
    env: typeof res.env === 'string' && res.env ? res.env : input.env,
    clientIdTail: typeof res.clientIdTail === 'string' ? res.clientIdTail : '',
    secretTail: typeof res.secretTail === 'string' ? res.secretTail : '',
  };
}

/**
 * Set (or clear) the OAuth redirect URL on its own, without re-entering the
 * keys. This is the field that changes most often in practice: every
 * `cloudflared tunnel` run hands out a new hostname.
 *
 * The backend validates it (HTTPS, no fragment, and localhost only in
 * Sandbox) and answers with the string it stored. Failures throw with the
 * backend's own message — REDIRECT_URI_NOT_REGISTERED in particular tells the
 * user exactly which string to paste into the Plaid dashboard, so callers
 * should render it verbatim.
 */
export async function saveRedirectUri(redirectUri: string): Promise<{ redirectUri: string }> {
  const res = await api<{ ok?: boolean; redirectUri?: string } | null>('/redirect-uri', {
    redirectUri: redirectUri.trim(),
  });
  if (!res || res.ok === false) {
    throw new Error('The Plaid backend did not confirm the redirect URL was saved. Try again.');
  }
  return { redirectUri: typeof res.redirectUri === 'string' ? res.redirectUri : redirectUri.trim() };
}

/**
 * Ask the backend for a Link token to open Plaid Link with.
 * Pass an itemId to get an update-mode token that repairs that existing item
 * (the backend attaches its stored access_token and omits `products`).
 */
export async function createLinkToken(itemId?: string): Promise<string> {
  const res = await api<{ linkToken?: string; link_token?: string }>(
    '/link-token',
    itemId ? { itemId } : {},
  );
  const token = res?.linkToken ?? res?.link_token;
  if (!token) throw new Error('The Plaid backend did not return a Link token.');
  return token;
}

/** Trade Link's public_token for a stored access token; returns the item's accounts. */
export async function exchangePublicToken(
  publicToken: string,
): Promise<{ itemId: string; institutionName: string; accounts: PlaidAccountDto[] }> {
  const res = await api<{
    itemId?: string;
    institutionName?: string;
    accounts?: PlaidAccountDto[];
  }>('/exchange', { publicToken });
  if (!res?.itemId) throw new Error('The Plaid backend did not return a linked item.');
  return {
    itemId: res.itemId,
    institutionName: res.institutionName || 'Bank',
    accounts: Array.isArray(res.accounts) ? res.accounts : [],
  };
}

/**
 * The one place a batch of per-item results is read off the wire. /sync and
 * /resync answer with the same shape, so they share this normalisation rather
 * than growing two copies that quietly disagree about, say, whether `removed`
 * may be missing.
 */
async function pullResults(path: '/sync' | '/resync', itemId?: string): Promise<SyncResult[]> {
  const res = await api<SyncResult[] | { results?: SyncResult[] } | null>(
    path,
    itemId ? { itemId } : {},
  );
  const list = Array.isArray(res) ? res : Array.isArray(res?.results) ? res.results : [];
  return list.map((r) => {
    const err = r?.error;
    const message = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
    return {
      itemId: r?.itemId ?? itemId ?? '',
      accounts: Array.isArray(r?.accounts) ? r.accounts : [],
      added: Array.isArray(r?.added) ? r.added : [],
      modified: Array.isArray(r?.modified) ? r.modified : [],
      removed: Array.isArray(r?.removed) ? r.removed : [],
      ...(message ? { error: { ...(err?.code ? { code: err.code } : {}), message } } : {}),
      ...(r?.needsReauth === true ? { needsReauth: true } : {}),
    };
  });
}

/** Pull new/changed transactions for one item (or all items when omitted). */
export async function syncItem(itemId?: string): Promise<SyncResult[]> {
  return pullResults('/sync', itemId);
}

/**
 * Clear the stored transactions/sync cursor(s) server-side and replay every
 * transaction Plaid still has — roughly two years — for one item, or for all
 * of them when itemId is omitted.
 *
 * This is the recovery path for a browser that holds no history: linking put
 * the access token and the cursor on the server, but the transactions
 * themselves only ever landed in whichever browser did the first pull.
 *
 * Same request/response handling as syncItem() by construction, so results
 * from either endpoint reach the store through exactly the same code.
 * A 409 SYNC_IN_PROGRESS comes back as a PlaidRequestError carrying the
 * backend's own message — surface it as-is; isSyncInProgress() identifies it.
 */
export async function fullResync(itemId?: string): Promise<SyncResult[]> {
  return pullResults('/resync', itemId);
}

/** Unlink an item at Plaid and forget its access token. */
export async function removeItem(itemId: string): Promise<void> {
  await api<unknown>(`/item/${encodeURIComponent(itemId)}`, undefined, 'DELETE');
}

// --- Finishing a link ------------------------------------------------------
//
// Two very different screens finish a Plaid link: the Connect-bank modal (the
// normal, non-OAuth case, where Link never left the page) and /oauth (an OAuth
// bank sent the browser back and Link resumed there). They must produce the
// same accounts and the same transactions, so the sequence lives here once.

/** The store's `applySync` action, structurally typed so lib/ needn't import the store. */
export type ApplySyncFn = (input: {
  accounts: Account[];
  added: Transaction[];
  modified?: Transaction[];
  removedIds?: string[];
}) => {
  accountsAdded: number;
  accountsUpdated: number;
  txnsAdded: number;
  txnsUpdated: number;
  txnsRemoved: number;
};

/**
 * `runSync` from src/pages/accounts/sync.ts. Injected rather than imported:
 * that module already imports this one, and a lib/ ⇄ pages/ import cycle is
 * exactly the kind of thing that works until a bundler decides it doesn't.
 */
export type RunSyncFn = (
  applySync: ApplySyncFn,
  itemId?: string,
) => Promise<{ txnsAdded: number }>;

export interface LinkedItem {
  itemId: string;
  institutionName: string;
  /** Accounts the bank returned for this item. */
  accountCount: number;
  /** Transactions the first sync brought in. */
  txnsAdded: number;
}

/**
 * Exchange Link's public_token and load the new bank into the store:
 * balances first (so the accounts exist), then the first transactions pull.
 *
 * Throws the backend's message on failure. When the exchange itself succeeded
 * but the sync did not, the item IS linked — callers should say so and point
 * at Sync rather than telling the user to link again.
 */
export async function finishLink(
  publicToken: string,
  applySync: ApplySyncFn,
  runSync: RunSyncFn,
): Promise<LinkedItem> {
  const linked = await exchangePublicToken(publicToken);
  applySync({ accounts: linked.accounts.map(toAccount), added: [] });
  const totals = await runSync(applySync, linked.itemId);
  return {
    itemId: linked.itemId,
    institutionName: linked.institutionName,
    accountCount: linked.accounts.length,
    txnsAdded: totals.txnsAdded,
  };
}

// --- Applying a pull to the store ------------------------------------------

/** One item the backend could not pull. The rest of the batch still went through. */
export interface PullFailure {
  itemId: string;
  message: string;
  needsReauth: boolean;
}

/**
 * What a pull changed. Field-compatible with SyncTotals in
 * pages/accounts/sync.ts, so summarizeSync() formats either one.
 */
export interface PullTotals {
  /** Items that reported back, successfully or not. */
  items: number;
  accountsAdded: number;
  accountsUpdated: number;
  txnsAdded: number;
  txnsUpdated: number;
  txnsRemoved: number;
  /** Empty on a clean run. */
  failures: PullFailure[];
}

/**
 * Map a batch of per-item results into our domain types and hand them to the
 * store in one upsert per item.
 *
 * Sync and full resync differ in exactly one thing — which endpoint produced
 * the results — so the Accounts page runs both through here. Everything that
 * has to hold for a sync (upsert by stable Plaid-derived id, a failed item
 * recorded in-band rather than aborting the batch, a partial batch still
 * landing) therefore holds for a resync by construction, and a change to one
 * cannot silently miss the other.
 *
 * (pages/accounts/sync.ts#runSync is the same walk for the Connect-bank modal
 * and the /oauth return, which fetch through their own paths.)
 */
export function applyPullResults(results: SyncResult[], applySync: ApplySyncFn): PullTotals {
  const totals: PullTotals = {
    items: 0,
    accountsAdded: 0,
    accountsUpdated: 0,
    txnsAdded: 0,
    txnsUpdated: 0,
    txnsRemoved: 0,
    failures: [],
  };

  for (const result of results) {
    // A failed item reports in-band with empty arrays — record why, then let
    // the upsert run anyway so a partially successful batch still lands.
    if (result.error) {
      totals.failures.push({
        itemId: result.itemId,
        message: result.error.message,
        needsReauth: result.needsReauth === true,
      });
    }

    const stats = applySync({
      accounts: (result.accounts ?? []).map(toAccount),
      added: (result.added ?? []).map(toTransaction),
      modified: (result.modified ?? []).map(toTransaction),
      removedIds: (result.removed ?? []).map(plaidTransactionId),
    });

    totals.items += 1;
    totals.accountsAdded += stats.accountsAdded;
    totals.accountsUpdated += stats.accountsUpdated;
    totals.txnsAdded += stats.txnsAdded;
    totals.txnsUpdated += stats.txnsUpdated;
    totals.txnsRemoved += stats.txnsRemoved;
  }

  return totals;
}

// --- Mapping into our domain types -----------------------------------------

/** Our stable Account.id for a Plaid account. */
export function plaidAccountId(plaidAccountId: string): string {
  return `plaid:${plaidAccountId}`;
}

/** Our stable Transaction.id for a Plaid transaction. */
export function plaidTransactionId(plaidTransactionId: string): string {
  return `plaid:${plaidTransactionId}`;
}

// The Plaid SDK types personal_finance_category.primary/.detailed as plain
// `string` (see PersonalFinanceCategory in node_modules/plaid/dist/api.d.ts) —
// the taxonomy itself lives in Plaid's pfc-taxonomy CSV, not in the package, and
// Plaid ships two live versions (PFCv1 and PFCv2). So this maps off the sixteen
// stable PRIMARY values and only reads `detailed` through prefix-stripped
// substring tests, which survive naming drift between taxonomy versions.
const PFC_PRIMARIES = [
  'BANK_FEES',
  'ENTERTAINMENT',
  'FOOD_AND_DRINK',
  'GENERAL_MERCHANDISE',
  'GENERAL_SERVICES',
  'GOVERNMENT_AND_NON_PROFIT',
  'HOME_IMPROVEMENT',
  'INCOME',
  'LOAN_PAYMENTS',
  'MEDICAL',
  'PERSONAL_CARE',
  'RENT_AND_UTILITIES',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'TRANSPORTATION',
  'TRAVEL',
] as const;

function normPfc(value?: string): string {
  return typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]+/g, '_') : '';
}

/** Longest primary that `detailed` is prefixed with, e.g. 'TRANSFER_IN_DEPOSIT' → 'TRANSFER_IN'. */
function primaryOfDetailed(detailed: string): string {
  let best = '';
  for (const p of PFC_PRIMARIES) {
    if ((detailed === p || detailed.startsWith(`${p}_`)) && p.length > best.length) best = p;
  }
  return best;
}

/**
 * Defensive only: PFCv1 has no streaming/subscription detailed value (Netflix
 * lands in ENTERTAINMENT_TV_AND_MOVIES). If a taxonomy version emits one, catch it.
 */
function isSubscriptionish(sub: string): boolean {
  return sub.includes('SUBSCRIPTION') || sub.includes('STREAMING');
}

/**
 * Plaid's personal_finance_category → our CategoryId.
 *
 * Every PRIMARY value is covered. Detailed values special-cased (PFCv1 spellings;
 * matched as prefix-stripped substrings so PFCv2 variants still hit):
 *   FOOD_AND_DRINK_GROCERIES              → groceries (all other FOOD_AND_DRINK → dining)
 *   LOAN_PAYMENTS_MORTGAGE_PAYMENT        → housing
 *   LOAN_PAYMENTS_CREDIT_CARD_PAYMENT     → transfer (paying our own card, not an expense)
 *   RENT_AND_UTILITIES_RENT               → housing (all other RENT_AND_UTILITIES → utilities)
 *   …_MORTGAGE… under RENT_AND_UTILITIES  → housing
 *   *_SUBSCRIPTION* / *_STREAMING* under ENTERTAINMENT and GENERAL_SERVICES → subscriptions
 * TRANSPORTATION_{GAS,PARKING,TOLLS,TAXIS_AND_RIDE_SHARES,PUBLIC_TRANSIT,BIKES_AND_SCOOTERS}
 * and TRAVEL_{FLIGHTS,LODGING,RENTAL_CARS} need no special case — Plaid already
 * splits the transport/travel boundary the same way we do, so the primary decides.
 *
 * Returns null for anything unrecognized so callers fall back to categorize().
 */
export function categoryFromPfc(primary?: string, detailed?: string): CategoryId | null {
  const d = normPfc(detailed);
  const p = normPfc(primary) || primaryOfDetailed(d);
  if (!p) return null;

  // Strip the primary prefix so substring tests can't match the primary's own
  // words — 'RENT_AND_UTILITIES_WATER' must not look like rent.
  const sub = d === p ? '' : d.startsWith(`${p}_`) ? d.slice(p.length + 1) : d;

  switch (p) {
    case 'INCOME':
      return 'income';
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
      return 'transfer';
    case 'LOAN_PAYMENTS':
      if (sub.includes('MORTGAGE')) return 'housing';
      if (sub.includes('CREDIT_CARD')) return 'transfer';
      return 'fees';
    case 'BANK_FEES':
      return 'fees';
    case 'ENTERTAINMENT':
      return isSubscriptionish(sub) ? 'subscriptions' : 'entertainment';
    case 'FOOD_AND_DRINK':
      return sub.includes('GROCER') ? 'groceries' : 'dining';
    case 'GENERAL_MERCHANDISE':
    case 'HOME_IMPROVEMENT':
      return 'shopping';
    case 'MEDICAL':
    case 'PERSONAL_CARE':
      return 'health';
    case 'GENERAL_SERVICES':
      return isSubscriptionish(sub) ? 'subscriptions' : 'other';
    case 'GOVERNMENT_AND_NON_PROFIT':
      return 'other';
    case 'TRANSPORTATION':
      return 'transport';
    case 'TRAVEL':
      return 'travel';
    case 'RENT_AND_UTILITIES':
      return sub === 'RENT' || sub.startsWith('RENT_') || sub.includes('MORTGAGE')
        ? 'housing'
        : 'utilities';
    default:
      return null;
  }
}

// Plaid's sandbox (and plenty of real banks) label accounts "Checking" or
// "Plaid Saving"; the officialName is the useful one in that case.
const GENERIC_ACCOUNT_NAME =
  /^(plaid\s+)?(primary\s+)?(checking|saving|savings|credit|credit\s*card|charge\s*card|money\s*market|cd|account|bank\s*account|business|cash\s*management)$/i;

/** Depository subtypes we file under 'savings'; everything else depository is 'checking'. */
const SAVINGS_SUBTYPES = new Set(['savings', 'money market', 'cd']);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toAccount(dto: PlaidAccountDto): Account {
  const name = (dto.name ?? '').trim();
  const officialName = (dto.officialName ?? '').trim();
  const displayName =
    officialName && (!name || GENERIC_ACCOUNT_NAME.test(name)) ? officialName : name || 'Account';

  const type = (dto.type ?? '').trim().toLowerCase();
  const subtype = (dto.subtype ?? '').trim().toLowerCase();
  const accountType: Account['type'] =
    type === 'credit' ? 'credit' : SAVINGS_SUBTYPES.has(subtype) ? 'savings' : 'checking';

  // For credit accounts Plaid's current balance is the amount owed, which is
  // already the positive number our model wants — pass it straight through.
  const balance = num(dto.balanceCurrent) ?? 0;
  const limit = num(dto.creditLimit);

  return {
    id: plaidAccountId(dto.accountId),
    name: displayName,
    institution: (dto.institutionName ?? '').trim() || 'Bank',
    type: accountType,
    mask: (dto.mask ?? '').trim() || '0000',
    balance: round2(balance),
    ...(accountType === 'credit' && limit !== null && limit > 0
      ? { creditLimit: round2(limit) }
      : {}),
    // No productId: the user links a card product themselves on the Accounts page.
    createdAt: todayIso(),
  };
}

// Synced rows are tagged 'plaid' so they stay distinguishable from hand-entered
// and CSV-imported ones (Transaction.source in src/types.ts).
const PLAID_SOURCE: Transaction['source'] = 'plaid';

/** Uses Plaid's merchant + category when present, falling back to our own categorize(). */
export function toTransaction(dto: PlaidTransactionDto): Transaction {
  const raw = dto.name ?? '';

  // categorize() runs at most once per transaction, and not at all when Plaid
  // gave us both a merchant name and a category we recognize.
  let guess: { merchant: string; category: CategoryId } | null = null;
  const fallback = (): { merchant: string; category: CategoryId } => {
    if (!guess) guess = categorize(raw);
    return guess;
  };

  const merchantName = (dto.merchantName ?? '').trim();
  const category = categoryFromPfc(dto.pfcPrimary, dto.pfcDetailed) ?? fallback().category;

  return {
    id: plaidTransactionId(dto.transactionId),
    accountId: plaidAccountId(dto.accountId),
    date: dto.date,
    merchant: merchantName || fallback().merchant,
    rawDescription: raw,
    amount: round2(num(dto.amount) ?? 0), // Plaid sign matches ours: positive = money out
    category,
    pending: dto.pending === true,
    source: PLAID_SOURCE,
  };
}
