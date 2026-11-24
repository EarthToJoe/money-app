import { create } from 'zustand';
import { useApp } from '../store';

// Keeps this device's Finch data in step with the copy on the server, so the
// phone and the Mac show the same thing.
//
// The browser store (src/store.ts) stays the source of truth on each device and
// keeps working offline exactly as before. This module watches it: any change
// is sent to PUT /api/state a moment later, and the server's copy is pulled
// when the app starts, comes back to the foreground, and every minute while
// open.
//
// Every save says which server revision it was based on. If another device
// saved in between, the server refuses and we take its newer copy. Your
// Anthropic API key is never synced: it stays on the device you typed it on.
//
// Server contract (server/index.js):
//   GET  /api/session -> { signedIn, passwordSet, sync }
//   POST /api/login   { password } -> { signedIn: true } and a cookie
//   POST /api/logout
//   GET  /api/state   -> { rev, updatedAt, state | null }
//   PUT  /api/state   { baseRev, state } -> { rev, updatedAt } | 409 { current }

export type SyncPhase =
  | 'checking' // asking the server what's available
  | 'off' // no server sync here (e.g. the backend isn't running)
  | 'signed-out' // the server needs a password first
  | 'syncing'
  | 'synced'
  | 'offline'; // couldn't reach the server; changes wait on this device

interface SyncStatus {
  phase: SyncPhase;
  lastSyncedAt: string | null;
  /** A one-off notice worth showing, e.g. after a conflict. */
  notice: string | null;
}

export const useSyncStatus = create<SyncStatus>(() => ({
  phase: 'checking',
  lastSyncedAt: null,
  notice: null,
}));

const setStatus = (patch: Partial<SyncStatus>) => useSyncStatus.setState(patch);

// --- What gets synced --------------------------------------------------------

type AppData = ReturnType<typeof useApp.getState>;

/** The same fields the store persists locally (see partialize in src/store.ts). */
const SYNCED_KEYS = [
  'accounts',
  'transactions',
  'budgets',
  'pointsBalances',
  'creditUsages',
  'settings',
  'manualCategoryIds',
  'demoLoaded',
  'demoVersion',
  'demoCleared',
] as const;

type SyncedKey = (typeof SYNCED_KEYS)[number];
export type SyncedState = Pick<AppData, SyncedKey>;

function snapshot(s: AppData): SyncedState {
  const out = {} as Record<SyncedKey, unknown>;
  for (const key of SYNCED_KEYS) out[key] = s[key];
  // Device-only: the API key never leaves the device it was typed on.
  const { anthropicApiKey: _local, ...settings } = s.settings;
  out.settings = settings;
  return out as SyncedState;
}

function changedSyncedFields(next: AppData, prev: AppData): boolean {
  return SYNCED_KEYS.some((key) => next[key] !== prev[key]);
}

/** Anything the user would mind losing: real accounts or anything they typed in. */
function hasRealData(s: Partial<SyncedState> | null | undefined): boolean {
  if (!s || s.demoLoaded) return false;
  return Boolean(
    s.accounts?.length || s.transactions?.length || s.budgets?.length || s.pointsBalances?.length,
  );
}

// --- Per-device bookkeeping ----------------------------------------------------

/** Which server revision this device last matched, and whether it has unsent edits. */
interface SyncMeta {
  rev: number | null;
  dirty: boolean;
}

const META_KEY = 'finch-sync';
const BACKUP_KEY = 'finch-v1-backup';

function readMeta(): SyncMeta {
  try {
    const parsed = JSON.parse(localStorage.getItem(META_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object') {
      return { rev: Number.isInteger(parsed.rev) ? parsed.rev : null, dirty: Boolean(parsed.dirty) };
    }
  } catch {
    // fall through
  }
  return { rev: null, dirty: false };
}

let meta: SyncMeta = { rev: null, dirty: false };

function saveMeta(patch: Partial<SyncMeta>) {
  meta = { ...meta, ...patch };
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    // Storage full or blocked: sync still works for this session.
  }
}

/** Keep a copy of this device's data before replacing it, just in case. */
function backUpLocal() {
  try {
    localStorage.setItem(
      BACKUP_KEY,
      JSON.stringify({ savedAt: new Date().toISOString(), state: snapshot(useApp.getState()) }),
    );
  } catch {
    // Best effort.
  }
}

// --- Talking to the server -----------------------------------------------------

class SignedOut extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 401) throw new SignedOut();
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: e.g. a static host answering /api with the app's HTML.
    throw new Error('not-finch-api');
  }
  return { status: res.status, body: body as T };
}

interface RemoteDoc {
  rev: number;
  updatedAt: string | null;
  state: SyncedState | null;
}

/** Replace this device's data with the server's, keeping device-only settings. */
function applyRemote(doc: RemoteDoc) {
  if (!doc.state) return;
  const local = useApp.getState();
  applying = true;
  try {
    useApp.setState({
      ...doc.state,
      settings: { ...doc.state.settings, anthropicApiKey: local.settings.anthropicApiKey },
    });
  } finally {
    applying = false;
  }
  saveMeta({ rev: doc.rev, dirty: false });
  setStatus({ phase: 'synced', lastSyncedAt: doc.updatedAt });
}

// --- The sync loop -------------------------------------------------------------

let started = false;
let watching = false;
let applying = false;
let queue: Promise<void> = Promise.resolve();
let pushTimer: ReturnType<typeof setTimeout> | undefined;
/** Bumped on every local edit, so a save that raced a newer edit doesn't clear `dirty`. */
let editCounter = 0;

/** Run one sync step at a time; a request that arrives meanwhile waits its turn. */
function serially(step: () => Promise<void>): Promise<void> {
  const run = queue.then(step);
  queue = run.catch(() => {});
  return run;
}

async function push(baseRev: number): Promise<void> {
  const edits = editCounter;
  setStatus({ phase: 'syncing' });
  const { status, body } = await api<{ rev: number; updatedAt: string; current?: RemoteDoc }>(
    '/api/state',
    { method: 'PUT', body: JSON.stringify({ baseRev, state: snapshot(useApp.getState()) }) },
  );

  if (status === 409 && body.current) {
    // Another device saved first. Its copy wins; this device's copy is kept
    // in a backup rather than thrown away.
    backUpLocal();
    applyRemote(body.current);
    setStatus({
      notice:
        'Your other device saved changes at the same time, so Finch kept those. Your latest edits on this device were set aside.',
    });
    return;
  }
  if (status >= 400) throw new Error(`save failed (${status})`);

  saveMeta({ rev: body.rev, dirty: editCounter !== edits });
  setStatus({ phase: 'synced', lastSyncedAt: body.updatedAt });
  if (meta.dirty) schedulePush();
}

async function pull(): Promise<void> {
  setStatus({ phase: 'syncing' });
  const { body: remote } = await api<RemoteDoc>('/api/state');
  const local = useApp.getState();

  // Nothing on the server yet: this device's data becomes the shared copy.
  if (!remote.state) return push(remote.rev);

  // First time this device syncs.
  if (meta.rev === null) {
    const localReal = hasRealData(local);
    const remoteReal = hasRealData(remote.state);
    if (localReal && !remoteReal) return push(remote.rev);
    if (localReal && remoteReal) {
      const keepServer = window.confirm(
        'This device has Finch data of its own, and so does your synced account.\n\n' +
          'OK: use your synced data on this device (this device’s copy is backed up).\n' +
          'Cancel: replace your synced data with this device’s copy.',
      );
      if (!keepServer) return push(remote.rev);
      backUpLocal();
    }
    return applyRemote(remote);
  }

  if (remote.rev === meta.rev) {
    if (meta.dirty) return push(remote.rev);
    setStatus({ phase: 'synced', lastSyncedAt: remote.updatedAt });
    return;
  }

  // The server moved on while this device also has unsent edits: the server's
  // copy wins and this device's is backed up.
  if (meta.dirty) {
    backUpLocal();
    setStatus({
      notice:
        'Your other device changed things while this one was offline, so Finch kept those. Edits made here while offline were set aside.',
    });
  }
  applyRemote(remote);
}

function handleFailure(err: unknown) {
  if (err instanceof SignedOut) setStatus({ phase: 'signed-out' });
  else if ((err as Error)?.message === 'not-finch-api') setStatus({ phase: 'off' });
  else setStatus({ phase: 'offline' });
}

function syncNow(): Promise<void> {
  const phase = useSyncStatus.getState().phase;
  if (phase === 'off' || phase === 'signed-out' || phase === 'checking') return Promise.resolve();
  return serially(pull).catch(handleFailure);
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    void serially(() => (meta.rev === null ? pull() : push(meta.rev))).catch(handleFailure);
  }, 1200);
}

function watchStore() {
  if (watching) return;
  watching = true;

  useApp.subscribe((next, prev) => {
    if (applying || !changedSyncedFields(next, prev)) return;
    editCounter += 1;
    saveMeta({ dirty: true });
    const phase = useSyncStatus.getState().phase;
    if (phase === 'synced' || phase === 'syncing') schedulePush();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow();
  });
  window.addEventListener('online', () => void syncNow());
  setInterval(() => {
    if (document.visibilityState === 'visible') void syncNow();
  }, 60_000);
}

/** Ask the server what's available and, if allowed, start syncing. */
export async function startCloudSync(): Promise<void> {
  if (!started) {
    started = true;
    meta = readMeta();
  }
  setStatus({ phase: 'checking' });

  let session: { signedIn: boolean; passwordSet: boolean; sync: boolean };
  try {
    session = (await api<typeof session>('/api/session')).body;
  } catch (err) {
    // No backend at all (or offline at launch): the app works locally.
    setStatus({ phase: err instanceof SignedOut ? 'signed-out' : navigator.onLine ? 'off' : 'offline' });
    if (!navigator.onLine) window.addEventListener('online', () => void startCloudSync(), { once: true });
    return;
  }

  if (!session.sync) {
    setStatus({ phase: session.passwordSet && !session.signedIn ? 'signed-out' : 'off' });
    return;
  }

  watchStore();
  setStatus({ phase: 'syncing' });
  await serially(pull).catch(handleFailure);
}

/** Returns an error message, or null on success. */
export async function signIn(password: string): Promise<string | null> {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return body?.error?.message ?? 'Sign-in failed.';
    }
  } catch {
    return "Couldn't reach Finch. Check your connection and try again.";
  }
  await startCloudSync();
  return null;
}

export async function signOut(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  setStatus({ phase: 'signed-out', lastSyncedAt: null });
}

export function dismissSyncNotice() {
  setStatus({ notice: null });
}
