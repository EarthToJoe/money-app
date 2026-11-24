// Finch's synced data: one JSON document that every device reads and writes.
//
// Until this existed, everything you entered in Finch lived in the browser that
// entered it. Open the app on your phone and you got an empty copy; edits there
// never reached your Mac. This file is the shared copy instead.
//
// The document is whatever the browser's store persists (accounts,
// transactions, budgets, points balances, credit usage, settings), stored
// as-is. The server does not interpret it, so adding a field to the app never
// needs a server change.
//
// Every save carries the revision it was based on. If another device saved in
// between, the save is refused with the newer copy instead of silently
// overwriting it (see PUT /api/state in server/index.js).
//
// Written atomically to server/.finch-data.json (gitignored, mode 0600), the
// same temp-file-then-rename pattern as the Plaid token store.

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const DATA_PATH = fileURLToPath(new URL('.finch-data.json', import.meta.url));

/** { rev, updatedAt, state } — rev 0 and state null mean "nothing saved yet". */
let cache = null;
let writeChain = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(DATA_PATH, 'utf8'));
    cache = {
      rev: Number.isInteger(parsed?.rev) && parsed.rev > 0 ? parsed.rev : 0,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
      state: parsed?.state && typeof parsed.state === 'object' ? parsed.state : null,
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Never start over on top of a file we merely failed to read: that would
      // replace someone's data with an empty document on the next save.
      throw new Error(`Finch's data file could not be read (${err.message}): ${DATA_PATH}`);
    }
    cache = { rev: 0, updatedAt: null, state: null };
  }
  return cache;
}

function persist(snapshot) {
  const body = JSON.stringify(snapshot);
  writeChain = writeChain.then(async () => {
    const tmp = `${DATA_PATH}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, DATA_PATH);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  });
  // A failed write must reach the caller (the save is reported as failed),
  // but must not poison the chain for the next one.
  const result = writeChain;
  writeChain = writeChain.catch(() => {});
  return result;
}

/** The current document. */
export async function readState() {
  const doc = await load();
  return { rev: doc.rev, updatedAt: doc.updatedAt, state: doc.state };
}

/**
 * Save `state` if `baseRev` is still the current revision.
 * Returns { ok: true, rev, updatedAt } or { ok: false, current } on a conflict.
 */
export function writeState(baseRev, state) {
  // Check-then-write runs one save at a time, so two devices saving at the
  // same moment can't both pass the revision check.
  const run = saveQueue.then(() => saveIfCurrent(baseRev, state));
  saveQueue = run.catch(() => {});
  return run;
}

let saveQueue = Promise.resolve();

async function saveIfCurrent(baseRev, state) {
  const doc = await load();
  if (baseRev !== doc.rev) return { ok: false, current: { ...doc } };

  const next = { rev: doc.rev + 1, updatedAt: new Date().toISOString(), state };
  await persist(next);
  cache = next;
  return { ok: true, rev: next.rev, updatedAt: next.updatedAt };
}
