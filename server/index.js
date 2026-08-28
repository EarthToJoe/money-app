// Finch's Plaid backend.
//
// The browser never talks to Plaid. It talks to this, over /api/plaid/*, and
// this holds the secret and the access tokens. Vite proxies /api here in dev.
//
// It boots with or without credentials: every endpoint answers with clean JSON
// either way, so the Accounts page can render the "not configured yet" state
// instead of hanging on a dead fetch.

import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ENV_PATH, readEnvFile, restoreEnvFile, upsertEnvValues } from './env-file.js';
import {
  ApiError,
  applyCredentials,
  baseLinkTokenRequest,
  credentialHint,
  describeError,
  getClient,
  NOT_CONFIGURED_MESSAGE,
  plaidSettings,
  pullTransactions,
  redact,
  requireClient,
  resolveInstitution,
  restoreCredentials,
  snapshotCredentials,
  toAccountDto,
  TRANSACTIONS_PRODUCT,
  validateRedirectUri,
} from './plaid.js';
import { clearCursors, deleteItem, getClientUserId, getItem, listItems, saveItem } from './store.js';
import { isLocalRequest, isLoopbackAddress, makeGate, readTunnelPassword } from './tunnel-auth.js';

// ESM evaluates every static import above before this line, so .env can't be
// loaded ahead of them. That's why plaid.js reads process.env lazily, inside
// plaidSettings(), rather than at module load — by the time any request or the
// startup log asks for the settings, this has run.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

// PLAID_PORT, not PORT: `PORT` is a generic variable that dev harnesses and
// PaaS hosts set for the *web* process, which would collide with vite.
const PORT = Number(process.env.PLAID_PORT) || 8787;

/** Vite dev server, plus anything extra the user names in CORS_ORIGIN. */
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
];

/**
 * The tunnel password, or '' when there is no tunnel in use. Read once at boot;
 * changing it means restarting this process (and the dev server).
 */
const TUNNEL_PASSWORD = readTunnelPassword();

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: ALLOWED_ORIGINS }));

// Defence in depth. Vite's proxy already sits behind the same gate, but this
// port is listening on every interface, so somebody could point a tunnel
// straight at :8787 and skip the dev server entirely. Requests that really are
// local — which is what the proxy's own hop looks like, since it connects from
// 127.0.0.1 with no forwarding headers — pass through untouched, so the normal
// path never sees a second prompt. See server/tunnel-auth.js for what "local"
// means and why a loopback check alone is not it.
//
// Mounted before express.json so an unauthenticated stranger can't make us
// parse a megabyte of their JSON, and before every route below.
app.use('/api', makeGate({ password: TUNNEL_PASSWORD, realm: 'Finch API' }));

app.use(express.json({ limit: '1mb' }));

/** Express 5 forwards rejected promises, but being explicit costs nothing. */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const plaidRoutes = express.Router();
app.use('/api/plaid', plaidRoutes);

// --- Status ----------------------------------------------------------------

/** PlaidItemSummary: account counts come from the cached list, so this never calls Plaid. */
function summarizeItem(record) {
  const summary = {
    itemId: record.itemId,
    institutionName: record.institutionName || 'Bank',
    accountCount: Array.isArray(record.accounts) ? record.accounts.length : 0,
    // A stored cursor means Plaid has already handed this item's history over
    // once — but not necessarily to the browser asking now, since the
    // transactions themselves live in localStorage. This is what lets the
    // client tell "never pulled, Sync will work" apart from "already pulled
    // into some other browser, only a full resync brings it back".
    hasSyncedOnce: Boolean(record.cursor),
  };
  if (record.lastSync) summary.lastSync = record.lastSync;
  if (record.needsReauth) summary.needsReauth = true;
  return summary;
}

plaidRoutes.get(
  '/status',
  route(async (_req, res) => {
    const { configured, env, redirectUri } = plaidSettings();
    const body = {
      configured,
      reachable: true,
      env,
      // '' when this install isn't using Plaid's OAuth flow. The Accounts page
      // needs it to decide whether Link has to be resumable at /oauth.
      redirectUri,
      items: (await listItems()).map(summarizeItem),
    };
    if (configured) {
      // Masked tails only — enough for the UI to show which keys are loaded.
      const { clientIdTail, secretTail } = credentialHint();
      body.clientIdTail = clientIdTail;
      body.secretTail = secretTail;
    } else {
      body.message = NOT_CONFIGURED_MESSAGE;
    }
    res.json(body);
  }),
);

// --- Credentials -------------------------------------------------------------
//
// The setup form posts the two Plaid keys here so the user never has to open a
// text editor. We validate them, apply them in-process, write them to .env, and
// prove they work with one live call to Plaid — rolling everything back if it
// doesn't, so a typo can never leave the app half-configured.

/**
 * This endpoint writes a file on the user's disk and holds their Plaid secret,
 * so it answers only to the person sitting at the machine running Finch.
 *
 * Finch is a local-first app: the backend is meant to be reached over the vite
 * proxy on the same box. But `app.listen(PORT)` binds every interface, so on a
 * shared network a stranger could otherwise POST here and overwrite the user's
 * keys (or read back which environment they use). CORS wouldn't stop that —
 * it's a browser convention, not a server check, and curl ignores it entirely.
 * Loopback is the one thing that genuinely means "same machine".
 *
 * The tunnel password does NOT open this door, and deliberately so: it proves
 * you are whoever ran `npm run tunnel`, from wherever you happen to be sitting,
 * while this endpoint (and /redirect-uri below) writes the file that holds the
 * Plaid secret. Those two guards stay loopback-only even for a caller who
 * presents perfectly valid Basic credentials.
 */
export function isLoopback(address) {
  // One implementation, shared with the gate in server/tunnel-auth.js.
  return isLoopbackAddress(address);
}

/** One save at a time: two overlapping rollbacks would fight over .env. */
let savingCredentials = false;

const CREDENTIAL_ENVS = new Set(['sandbox', 'production']);
/** Plaid's keys are hex-ish: letters and digits, nothing else. */
const KEY_CHARACTERS = /^[a-zA-Z0-9]+$/;

/** A specific complaint about one field, or null. Never quotes the value back. */
function credentialProblem(clientId, secret, env) {
  if (!clientId) return 'Paste your Plaid client ID — that field was empty.';
  if (clientId.length < 20 || clientId.length > 40 || !KEY_CHARACTERS.test(clientId)) {
    return 'That client ID looks wrong — it should be about 24 letters and numbers with no spaces.';
  }

  if (!secret) return 'Paste your Plaid secret — that field was empty.';
  if (secret.length < 20 || secret.length > 60 || !KEY_CHARACTERS.test(secret)) {
    return 'That secret looks wrong — it should be about 30 letters and numbers with no spaces.';
  }

  if (!CREDENTIAL_ENVS.has(env)) return 'Choose either sandbox or production — nothing else is a Plaid environment.';

  return null;
}

/**
 * Prove the settings currently loaded actually work, with one live call.
 *
 * /link/token/create is the cheapest call Plaid offers that authenticates — it
 * costs nothing, touches no bank, and the token is simply discarded. It is also
 * the call that carries redirect_uri, so the same round trip catches a redirect
 * URL that hasn't been registered in the Plaid dashboard.
 *
 * Returns null when everything checks out, or describeError()'s report when it
 * doesn't. Described here rather than by the caller because describeError()
 * redacts against the credentials loaded right now — after a rollback it could
 * no longer mask them.
 */
async function verifyLoadedSetup() {
  try {
    const plaid = requireClient();
    await plaid.linkTokenCreate({
      ...baseLinkTokenRequest(await getClientUserId()),
      products: [TRANSACTIONS_PRODUCT],
    });
    return null;
  } catch (err) {
    return describeError(err);
  }
}

/**
 * Did Plaid refuse the link token because of the redirect URL rather than the
 * keys? An unregistered redirect_uri comes back as INVALID_FIELD with a message
 * naming the field. INVALID_FIELD on its own is enough to be confident: the only
 * field a verification token carries beyond the fixed ones is redirect_uri.
 */
function isUnregisteredRedirect(info, redirectUri) {
  if (!redirectUri || info.status >= 500) return false;
  return info.code === 'INVALID_FIELD' || /redirect[_\s-]?uri/i.test(info.message ?? '');
}

/**
 * A failed verification as { status, body }. Callers roll back *before* calling
 * this, so every message here can honestly say nothing was kept.
 */
function verificationFailureBody(info, redirectUri, unreachableLead) {
  const error = {};
  let status;

  if (isUnregisteredRedirect(info, redirectUri)) {
    status = 400;
    error.code = 'REDIRECT_URI_NOT_REGISTERED';
    error.message =
      `Plaid does not recognise ${redirectUri}. Add it in the Plaid dashboard under ` +
      `Developers → API → Allowed redirect URIs, then save again. ${info.message}`;
  } else if (info.status < 500) {
    // A 4xx from Plaid means what we sent was refused. A 5xx or a dead
    // connection means we couldn't check at all — a different thing to tell the
    // user, though either way the unverified settings don't get to stay.
    status = 400;
    error.code = 'PLAID_REJECTED';
    error.message = info.message;
  } else {
    status = 502;
    error.code = 'PLAID_UNREACHABLE';
    error.message = `${unreachableLead} ${info.message}`;
  }

  if (info.plaidType) error.plaidType = info.plaidType;
  return { status, body: { error } };
}

plaidRoutes.post(
  '/credentials',
  route(async (req, res) => {
    // isLocalRequest, NOT a bare address check: cloudflared runs on this
    // machine and dials 127.0.0.1, so a request forwarded in from the public
    // internet arrives with a loopback remoteAddress. Only a request that is
    // ALSO unforwarded and addressed to a loopback host is really local.
    if (!isLocalRequest(req)) {
      return res.status(403).json({
        error: {
          code: 'LOCAL_ONLY',
          message:
            "Keys can't be set over the tunnel — that's deliberate, so nobody who finds the tunnel URL can change them. " +
            'Open http://localhost:5173 in a browser on this computer, set your keys and redirect URL there, ' +
            'then come back to the tunnel address to link your bank.',
        },
      });
    }

    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
    const secret = typeof req.body?.secret === 'string' ? req.body.secret.trim() : '';
    // The form always sends env; default to sandbox so a bare POST can't land in production.
    const env = typeof req.body?.env === 'string' && req.body.env.trim() ? req.body.env.trim().toLowerCase() : 'sandbox';

    const problem = credentialProblem(clientId, secret, env);
    if (problem) throw new ApiError(400, 'INVALID_CREDENTIALS', problem);

    // An omitted redirectUri means "leave OAuth as it is" — re-typing the keys
    // shouldn't quietly unplug a working tunnel. Sending "" is how you clear it.
    // Either way it is judged against the env being *submitted*, since
    // http://localhost stops being legal the moment you move to production.
    const submittedRedirect =
      typeof req.body?.redirectUri === 'string' ? req.body.redirectUri : plaidSettings().redirectUri;
    const checkedRedirect = validateRedirectUri(submittedRedirect, env);
    if (!checkedRedirect.ok) throw new ApiError(400, 'INVALID_REDIRECT_URI', checkedRedirect.message);
    const redirectUri = checkedRedirect.value;

    if (savingCredentials) {
      throw new ApiError(409, 'CREDENTIALS_BUSY', 'Another save is still in progress. Try again in a moment.');
    }
    savingCredentials = true;

    // Everything needed to put the machine back exactly as it was.
    const previousVars = snapshotCredentials();
    const previousFile = await readEnvFile(ENV_PATH);

    try {
      applyCredentials({ clientId, secret, env, redirectUri });

      try {
        // PLAID_REDIRECT_URI is written even when empty, so clearing OAuth
        // leaves a visible `PLAID_REDIRECT_URI=` rather than a stale value.
        await upsertEnvValues(ENV_PATH, {
          PLAID_CLIENT_ID: clientId,
          PLAID_SECRET: secret,
          PLAID_ENV: env,
          PLAID_REDIRECT_URI: redirectUri,
        });
      } catch (err) {
        restoreCredentials(previousVars);
        throw new ApiError(
          500,
          'ENV_WRITE_FAILED',
          `Couldn't save to .env (${redact(err.message) || 'unknown error'}). Check the file's permissions.`,
        );
      }

      // Prove the keys — and the redirect URL that now rides along with them —
      // actually work before telling the user they're set up.
      const info = await verifyLoadedSetup();
      if (info) {
        restoreCredentials(previousVars);
        await restoreEnvFile(ENV_PATH, previousFile);

        const failure = verificationFailureBody(
          info,
          redirectUri,
          "Nothing was saved — Finch couldn't reach Plaid to check those keys.",
        );

        console.warn(
          failure.status === 502
            ? `[plaid] couldn't verify credentials: ${info.code} — ${redact(info.message)}`
            : `[plaid] credentials rejected by Plaid: ${info.code} — ${redact(info.message)}`,
        );

        return res.status(failure.status).json(failure.body);
      }

      const { clientIdTail, secretTail } = credentialHint();
      console.log(
        `Plaid credentials saved (${env}) — client …${clientIdTail}` +
          (redirectUri ? `, OAuth redirect ${redirectUri}` : ''),
      );
      return res.json({ ok: true, env, redirectUri, clientIdTail, secretTail, savedTo: '.env' });
    } finally {
      savingCredentials = false;
    }
  }),
);

// --- Redirect URI ------------------------------------------------------------
//
// A public HTTPS tunnel (cloudflared and friends) hands out a new hostname
// every time it restarts, so the redirect URL changes far more often than the
// keys do. This lets the user re-point it on its own — same loopback guard,
// same write-verify-or-roll-back dance, but without making them dig their Plaid
// secret out again just to paste a new tunnel address.

plaidRoutes.post(
  '/redirect-uri',
  route(async (req, res) => {
    // Same reasoning as /credentials: a tunnelled request looks loopback at
    // the socket, so the forwarded-headers and Host checks do the real work.
    if (!isLocalRequest(req)) {
      return res.status(403).json({
        error: {
          code: 'LOCAL_ONLY',
          message:
            "The redirect URL can't be changed over the tunnel — that's deliberate. " +
            'Open http://localhost:5173 on this computer, change it there, then return to the tunnel address to link your bank.',
        },
      });
    }

    // Verification needs a live Plaid call, which needs keys. Checked before the
    // URL itself so an unconfigured install gets the useful message, not a
    // lecture about URL syntax.
    const { configured, clientId, secret, env } = plaidSettings();
    if (!configured) throw new ApiError(400, 'PLAID_NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE);

    // Required rather than optional here: this endpoint exists only to set the
    // field, so a body without it is a mistake, not a request to clear it.
    if (typeof req.body?.redirectUri !== 'string') {
      throw new ApiError(
        400,
        'INVALID_REDIRECT_URI',
        'Send { "redirectUri": "https://your-tunnel.example.com/oauth" }. An empty string turns OAuth off.',
      );
    }

    const checked = validateRedirectUri(req.body.redirectUri, env);
    if (!checked.ok) throw new ApiError(400, 'INVALID_REDIRECT_URI', checked.message);
    const redirectUri = checked.value;

    if (savingCredentials) {
      throw new ApiError(409, 'CREDENTIALS_BUSY', 'Another save is still in progress. Try again in a moment.');
    }
    savingCredentials = true;

    const previousVars = snapshotCredentials();
    const previousFile = await readEnvFile(ENV_PATH);

    try {
      // The keys come straight back out of plaidSettings(), so the user never
      // has to re-send a secret to change a URL.
      applyCredentials({ clientId, secret, env, redirectUri });

      try {
        await upsertEnvValues(ENV_PATH, { PLAID_REDIRECT_URI: redirectUri });
      } catch (err) {
        restoreCredentials(previousVars);
        throw new ApiError(
          500,
          'ENV_WRITE_FAILED',
          `Couldn't save to .env (${redact(err.message) || 'unknown error'}). Check the file's permissions.`,
        );
      }

      const info = await verifyLoadedSetup();
      if (info) {
        restoreCredentials(previousVars);
        await restoreEnvFile(ENV_PATH, previousFile);

        const failure = verificationFailureBody(
          info,
          redirectUri,
          "Nothing changed — Finch couldn't reach Plaid to check that redirect URL.",
        );

        console.warn(`[plaid] redirect URL not accepted: ${info.code} — ${redact(info.message)}`);
        return res.status(failure.status).json(failure.body);
      }

      console.log(redirectUri ? `Plaid OAuth redirect set to ${redirectUri}` : 'Plaid OAuth redirect cleared');
      return res.json({ ok: true, redirectUri });
    } finally {
      savingCredentials = false;
    }
  }),
);

// --- Link token ------------------------------------------------------------

plaidRoutes.post(
  '/link-token',
  route(async (req, res) => {
    const plaid = requireClient();
    const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId.trim() : '';

    const request = baseLinkTokenRequest(await getClientUserId());

    if (itemId) {
      // Update mode: repair an item Plaid has locked out. No products — the
      // item already has them, and passing them here is rejected.
      const record = await getItem(itemId);
      if (!record) throw new ApiError(404, 'ITEM_NOT_FOUND', `No linked bank with id ${itemId}.`);
      request.access_token = record.accessToken;
    } else {
      request.products = [TRANSACTIONS_PRODUCT];
      request.transactions = { days_requested: 730 };
    }

    const { data } = await plaid.linkTokenCreate(request);
    res.json({ linkToken: data.link_token });
  }),
);

// --- Exchange --------------------------------------------------------------

plaidRoutes.post(
  '/exchange',
  route(async (req, res) => {
    const plaid = requireClient();
    const publicToken = typeof req.body?.publicToken === 'string' ? req.body.publicToken.trim() : '';
    if (!publicToken) {
      throw new ApiError(400, 'PUBLIC_TOKEN_REQUIRED', 'Send { "publicToken": "..." } from Plaid Link.');
    }

    const { data: exchanged } = await plaid.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchanged.access_token;
    const itemId = exchanged.item_id;

    const { institutionName, institutionId } = await resolveInstitution(plaid, accessToken);

    const { data: accountsData } = await plaid.accountsGet({ access_token: accessToken });
    const accounts = accountsData.accounts.map((account) => toAccountDto(account, institutionName, itemId));

    // Relinking the same item keeps its cursor, so a repair doesn't re-pull two years.
    await saveItem(itemId, { accessToken, institutionName, institutionId, needsReauth: false, accounts });

    console.log(`[plaid] linked ${institutionName} — ${accounts.length} account(s), item ${itemId}`);
    res.json({ itemId, institutionName, accounts });
  }),
);

// --- Sync ------------------------------------------------------------------
//
// Two routes, one code path. POST /sync pulls the delta since each item's
// stored cursor; POST /resync throws those cursors away first so Plaid replays
// every transaction from the beginning. Everything after that decision — how a
// record is pulled, when its cursor moves, what the response looks like — is
// deliberately the same function, because the two must never drift: the client
// applies both results through the same code, and a resync that answered in a
// different shape would be a resync the client couldn't use.

/**
 * One item's pass. Balances first, then transactions: if either call fails the
 * cursor stays where it was, so the next sync replays the same window instead
 * of skipping it. A failed item reports its error in-band and never takes the
 * rest of the batch down with it.
 *
 * `fullResync` changes nothing about the work — the caller has already cleared
 * the cursor by then — only which line gets logged.
 */
async function syncRecord(plaid, record, { fullResync = false } = {}) {
  const result = { itemId: record.itemId, accounts: [], added: [], modified: [], removed: [] };

  try {
    const { data } = await plaid.accountsGet({ access_token: record.accessToken });
    const accounts = data.accounts.map((account) =>
      toAccountDto(account, record.institutionName || 'Bank', record.itemId),
    );

    const pulled = await pullTransactions(plaid, record.accessToken, record.cursor);

    result.accounts = accounts;
    result.added = pulled.added;
    result.modified = pulled.modified;
    result.removed = pulled.removed;

    // Cursor and lastSync only move after a complete, clean pass.
    await saveItem(record.itemId, {
      accounts,
      cursor: pulled.nextCursor,
      lastSync: new Date().toISOString(),
      needsReauth: false,
    });

    const institution = record.institutionName || 'Bank';
    console.log(
      fullResync
        ? // After a cursor reset Plaid replays the lot as `added`, so that count
          // is the whole history — the number the user is waiting to see land.
          `[plaid] full resync: ${institution} — ${pulled.added.length} transactions`
        : `[plaid] synced ${institution} — ${pulled.added.length} added, ` +
            `${pulled.modified.length} modified, ${pulled.removed.length} removed`,
    );
  } catch (err) {
    const info = describeError(err);
    const needsReauth = info.code === 'ITEM_LOGIN_REQUIRED';

    if (needsReauth) await saveItem(record.itemId, { needsReauth: true });

    result.error = { code: info.code, message: info.message };
    if (info.plaidType) result.error.plaidType = info.plaidType;
    if (needsReauth) result.needsReauth = true;

    console.warn(`[plaid] sync failed for item ${record.itemId}: ${info.code} — ${info.message}`);
  }

  return result;
}

/** The items one pass covers: the named one, or every linked item. */
async function syncTargets(itemId) {
  if (!itemId) return listItems();
  const record = await getItem(itemId);
  if (!record) throw new ApiError(404, 'ITEM_NOT_FOUND', `No linked bank with id ${itemId}.`);
  return [record];
}

/**
 * One pull at a time, across /sync and /resync alike.
 *
 * A cursor is consumed by *reading* it: Plaid hands back the next window and a
 * new position, and only the position we manage to persist counts. Two passes
 * running at once therefore both start from the same cursor, both receive the
 * same window, and whichever finishes second overwrites the first's position —
 * so a whole window can be spent with nothing to show for it. That is precisely
 * the failure this endpoint exists to repair, so it must not be the way it
 * behaves. /resync is worse still: it would clear the cursor out from under a
 * /sync already mid-pagination.
 *
 * Hence one flag shared by both routes rather than one each — refusing an
 * overlapping /sync during a /resync matters just as much as the reverse.
 */
let pullRunning = false;

const SYNC_IN_PROGRESS_MESSAGE = 'A sync is already running — wait for it to finish.';

/**
 * The body of both routes. `fullResync` is the entire difference between them:
 * it drops the stored cursors first, so the identical pull below starts from
 * the beginning of history rather than from wherever the last pass stopped.
 */
async function handlePull(req, res, { fullResync }) {
  const plaid = requireClient();
  const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId.trim() : '';

  // Resolved before the lock so an id we don't hold is a clean 404 even while
  // another pass is running — a 409 there would send the caller off waiting for
  // something that was never going to help.
  let records = await syncTargets(itemId);

  if (pullRunning) throw new ApiError(409, 'SYNC_IN_PROGRESS', SYNC_IN_PROGRESS_MESSAGE);
  pullRunning = true;

  try {
    if (fullResync) {
      // Inside the lock, so no concurrent pass can be holding one of these
      // cursors. Passing `undefined` rather than '' is what means "every item".
      await clearCursors(itemId || undefined);
      // Re-read: the records above are snapshots taken before the clear and
      // still carry the cursors we just dropped, and syncRecord reads the
      // cursor off the record it is handed.
      records = await syncTargets(itemId);
    }

    const results = [];
    for (const record of records) {
      results.push(await syncRecord(plaid, record, { fullResync }));
    }

    res.json(results);
  } finally {
    pullRunning = false;
  }
}

plaidRoutes.post(
  '/sync',
  route((req, res) => handlePull(req, res, { fullResync: false })),
);

/**
 * Full resync — forget the cursors, replay everything.
 *
 * The recovery for a user whose history is stranded: the transactions landed in
 * one browser's localStorage, that browser is no longer the one in front of
 * them, and a plain Sync now returns an empty delta because the cursor moved
 * past all of it. Clearing the cursor makes Plaid send the whole history again.
 *
 * This sits behind the normal tunnel-password gate, exactly like /sync, and
 * NOT behind the loopback-only guard that /credentials and /redirect-uri use.
 * Those two write .env and hold the Plaid secret; this one reads bank data the
 * caller is already entitled to read through /sync and rewrites a local sync
 * position. Nothing it can do is beyond what /sync already exposes. Locking it
 * to loopback would also aim it away from the people who need it most — the
 * stranded browser is very often the phone or laptop on the far end of the
 * tunnel, which is how the history ended up somewhere else in the first place.
 *
 * A failed resync leaves the cursor cleared rather than restoring it. That is
 * deliberate: a cleared cursor only ever means "the next pull returns
 * everything", so a retry still works. Putting the old one back would hand the
 * user another empty delta.
 */
plaidRoutes.post(
  '/resync',
  route((req, res) => handlePull(req, res, { fullResync: true })),
);

// --- Remove ----------------------------------------------------------------

/** Plaid has already lost the item — nothing left to unlink, so drop it locally. */
const ALREADY_GONE = new Set(['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN']);

plaidRoutes.delete(
  '/item/:itemId',
  route(async (req, res) => {
    const { itemId } = req.params;
    const record = await getItem(itemId);
    if (!record) {
      throw new ApiError(404, 'ITEM_NOT_FOUND', `No linked bank with id ${itemId}. It may already have been removed.`);
    }

    const plaid = getClient();
    if (plaid && record.accessToken) {
      try {
        await plaid.itemRemove({ access_token: record.accessToken });
      } catch (err) {
        const info = describeError(err);
        // Anything else and we keep the record so the user can retry rather
        // than orphaning a live item at Plaid.
        if (!ALREADY_GONE.has(info.code)) throw err;
        console.warn(`[plaid] Plaid had already dropped item ${itemId} (${info.code}); removing locally`);
      }
    }

    await deleteItem(itemId);
    console.log(`[plaid] unlinked ${record.institutionName || 'Bank'} — item ${itemId}`);
    res.json({ removed: true });
  }),
);

// --- Fallbacks -------------------------------------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No endpoint at ${req.method} ${req.originalUrl}.` },
  });
});

app.use((err, req, res, _next) => {
  const info = describeError(err);
  if (info.status >= 500) {
    console.error(`[plaid] ${req.method} ${req.path} → ${info.code}: ${info.message}`);
  }

  const body = { error: { code: info.code, message: info.message } };
  if (info.plaidType) body.error.plaidType = info.plaidType;
  res.status(info.status).json(body);
});

// --- Boot ------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  console.error(`[plaid] unhandled rejection: ${describeError(reason).message}`);
});

const server = app.listen(PORT, () => {
  const { configured, env, redirectUri } = plaidSettings();

  const line = configured
    ? `Plaid backend on :${PORT} — ${env}, credentials loaded`
    : `Plaid backend on :${PORT} — no credentials yet; add PLAID_CLIENT_ID and PLAID_SECRET to .env (copy .env.example)`;

  // The password itself is never printed — `npm run tunnel` is what shows it,
  // once, to the person who asked for a tunnel.
  const gated = TUNNEL_PASSWORD ? ' · tunnel password set' : '';

  console.log((redirectUri ? `${line}, OAuth redirect ${redirectUri}` : line) + gated);

  // A tunnel URL saved under sandbox and still sitting there after a switch to
  // production would fail every link with INVALID_FIELD. Say so at boot rather
  // than at the moment the user is trying to connect a bank.
  if (redirectUri) {
    const checked = validateRedirectUri(redirectUri, env);
    if (!checked.ok) console.warn(`[plaid] PLAID_REDIRECT_URI in .env is not usable: ${checked.message}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — stop the other process or set PLAID_PORT in .env.`);
    process.exit(1);
  }
  throw err;
});
