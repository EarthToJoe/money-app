// Token store for the Plaid backend.
//
// Everything Plaid hands us that must outlive a restart lives here: the access
// token per item, the transactions/sync cursor, and a cached copy of each
// item's accounts so /status can answer without calling Plaid at all.
//
// The file is server/.plaid-store.json (gitignored) and is written atomically —
// serialise to a temp file, then rename over the real one — so a crash mid-write
// can never leave a half-written JSON file holding the only copy of an access
// token. Access tokens are never logged.

import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const STORE_PATH = fileURLToPath(new URL('.plaid-store.json', import.meta.url));

/**
 * Defaults for an item we have not seen before. A factory, not a constant, so
 * no two records can end up sharing one `accounts` array.
 */
const blankItem = () => ({
  accessToken: null,
  institutionName: 'Bank',
  institutionId: null,
  cursor: null,
  lastSync: null,
  needsReauth: false,
  /** Cached PlaidAccountDto[] from the last exchange/sync — keeps /status cheap and offline-safe. */
  accounts: [],
});

/** In-memory copy of the file. Loaded lazily; the file is only created on first write. */
let cache = null;

/** Writes are chained so two concurrent requests can't interleave renames. */
let writeChain = Promise.resolve();

async function load() {
  if (cache) return cache;

  try {
    const parsed = JSON.parse(await readFile(STORE_PATH, 'utf8'));
    cache = {
      clientUserId: typeof parsed?.clientUserId === 'string' ? parsed.clientUserId : null,
      items: parsed?.items && typeof parsed.items === 'object' ? parsed.items : {},
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[plaid] token store unreadable (${err.message}); starting a fresh one at ${STORE_PATH}`);
    }
    cache = { clientUserId: null, items: {} };
  }

  return cache;
}

function persist() {
  const snapshot = JSON.stringify(cache, null, 2);

  writeChain = writeChain
    .then(async () => {
      const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
      try {
        // 0600: this file holds access tokens, so keep it owner-only.
        await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, STORE_PATH);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    })
    .catch((err) => {
      console.error(`[plaid] could not write the token store: ${err.message}`);
    });

  return writeChain;
}

/**
 * A stable, non-identifying id for this install, sent to Plaid as
 * user.client_user_id. Generated once and kept for the life of the store.
 */
export async function getClientUserId() {
  const store = await load();
  if (!store.clientUserId) {
    store.clientUserId = `finch-${randomUUID()}`;
    await persist();
  }
  return store.clientUserId;
}

/** Every linked item, each as { itemId, ...record }. */
export async function listItems() {
  const store = await load();
  return Object.entries(store.items).map(([itemId, record]) => ({ ...blankItem(), ...record, itemId }));
}

/** One item, or null when we've never linked it. */
export async function getItem(itemId) {
  const store = await load();
  const record = store.items[itemId];
  return record ? { ...blankItem(), ...record, itemId } : null;
}

/** Create or patch an item. Unspecified fields keep their previous values. */
export async function saveItem(itemId, patch) {
  const store = await load();
  const previous = store.items[itemId] ?? {};
  const next = { ...blankItem(), ...previous, ...patch };
  delete next.itemId; // the key is the id; don't duplicate it inside the record
  store.items[itemId] = next;
  await persist();
  return { ...next, itemId };
}

/**
 * Drop the transactions/sync cursor from one item, or from every item when no
 * id is given. Returns how many items were touched (0 means no such item).
 *
 * This is the one primitive a "full resync" needs. transactions/sync is a
 * cursor walk: the first call returns an item's whole history and hands back a
 * position, and every later call returns only what changed since that position.
 * The transactions themselves live in one browser's localStorage, so once that
 * browser is gone — cleared, swapped, or simply a different machine than the
 * one that linked the bank — the history is unreachable and a plain sync
 * returns an empty delta. Forgetting the cursor is what makes Plaid replay
 * everything from the beginning.
 *
 * `lastSync` goes with it: it means "we have data as of then", which stops
 * being true the moment the position it refers to is thrown away.
 *
 * Nothing else is touched. The access token, institution, and needsReauth flag
 * all survive, so a full resync never costs the user a trip back through Link.
 */
export async function clearCursors(itemId) {
  const store = await load();
  const ids = itemId === undefined || itemId === null ? Object.keys(store.items) : [itemId];

  let touched = 0;
  for (const id of ids) {
    const record = store.items[id];
    if (!record) continue;
    // Counted per item, not per field removed: an item that had never synced
    // still counts, so a caller can tell "no item with that id" (0) apart from
    // "that item simply had no cursor yet" (1).
    touched += 1;
    delete record.cursor;
    delete record.lastSync;
  }

  if (touched) await persist();
  return touched;
}

/** Forget an item. Returns false when there was nothing to forget. */
export async function deleteItem(itemId) {
  const store = await load();
  if (!store.items[itemId]) return false;
  delete store.items[itemId];
  await persist();
  return true;
}
