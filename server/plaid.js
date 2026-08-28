// Plaid client, DTO mapping, and error unwrapping.
//
// The secret and every access token stay in this process. The browser only ever
// sees the DTOs at the bottom of this file, which contain neither.
//
// Environment variables are read lazily (not at module load) so index.js can
// call dotenv.config() in its own body and still have this module see the
// values — ESM evaluates imported modules before the importing module's body.

import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from 'plaid';

/** Plaid ships exactly two hosts: sandbox and production. */
const KNOWN_ENVS = Object.keys(PlaidEnvironments);

let settings = null;

/**
 * { clientId, secret, env, basePath, configured, redirectUri } — memoised on
 * first read. `redirectUri` is '' when the install isn't using Plaid's OAuth
 * flow, which is the normal state in Sandbox.
 */
export function plaidSettings() {
  if (settings) return settings;

  const requested = (process.env.PLAID_ENV ?? 'sandbox').trim().toLowerCase();
  const clientId = (process.env.PLAID_CLIENT_ID ?? '').trim();
  const secret = (process.env.PLAID_SECRET ?? '').trim();

  settings = {
    clientId,
    secret,
    // PlaidStatus.env on the client is 'sandbox' | 'production' | 'unknown'.
    env: KNOWN_ENVS.includes(requested) ? requested : 'unknown',
    basePath: PlaidEnvironments[requested] ?? PlaidEnvironments.sandbox,
    configured: Boolean(clientId && secret),
    // Not part of `configured`: an install is perfectly well set up without it.
    redirectUri: (process.env.PLAID_REDIRECT_URI ?? '').trim(),
  };

  return settings;
}

let client = null;

/** The PlaidApi client, or null when credentials haven't been set up yet. */
export function getClient() {
  const { clientId, secret, basePath, configured } = plaidSettings();
  if (!configured) return null;

  if (!client) {
    client = new PlaidApi(
      new Configuration({
        basePath,
        baseOptions: {
          headers: {
            'PLAID-CLIENT-ID': clientId,
            'PLAID-SECRET': secret,
            'Plaid-Version': '2020-09-14',
          },
        },
      }),
    );
  }

  return client;
}

/** Thrown for problems we detect ourselves, so the error middleware can pick a status. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const NOT_CONFIGURED_MESSAGE =
  'Plaid credentials are missing. Copy .env.example to .env, fill in PLAID_CLIENT_ID and PLAID_SECRET from dashboard.plaid.com, then restart the server.';

/** The client for a request, or a clean 400 explaining what to add to .env. */
export function requireClient() {
  const found = getClient();
  if (!found) throw new ApiError(400, 'PLAID_NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE);
  return found;
}

// --- Redirect URI (Plaid OAuth) ---------------------------------------------
//
// Most big US banks — Chase, Capital One, Bank of America, Schwab, PNC, US Bank
// — will only link through Plaid's OAuth flow. In that flow Link navigates the
// whole browser page away to the bank's own site, the bank sends the user back
// to an address we nominated, and the app re-opens Link there to finish. That
// address is `redirect_uri` on /link/token/create.
//
// Plaid is strict about it. The string has to match one registered in the
// dashboard (Developers -> API -> Allowed redirect URIs) exactly, it has to be
// https outside of Sandbox, and it may carry neither a query string nor a
// fragment — Plaid appends its own query parameters on the way back.
//
// Empty means "not using OAuth", and that is a perfectly valid setup: in
// Sandbox every institution links with a username and password, so the field is
// simply left off the request.

/** The only hosts Plaid will take over plain http — and only in Sandbox. */
const HTTP_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Check a redirect URI before it is saved or sent to Plaid.
 *
 * Returns { ok: true, value } or { ok: false, message }. `value` is the trimmed
 * input and never a normalised URL: Plaid compares against the dashboard entry
 * character for character, so `https://x.com/oauth` and `https://x.com/oauth/`
 * are two different registrations and we must send back exactly what was typed.
 *
 * The empty string is valid and means "this install isn't using OAuth".
 */
export function validateRedirectUri(value, env) {
  if (value === undefined || value === null) return { ok: true, value: '' };
  if (typeof value !== 'string') {
    return { ok: false, message: 'The redirect URL has to be text — paste the full https:// address.' };
  }

  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, value: '' };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: `That isn't a URL. Paste the whole address including https://, for example https://your-tunnel.trycloudflare.com/oauth.`,
    };
  }

  const sandbox = (typeof env === 'string' ? env : '').trim().toLowerCase() === 'sandbox';

  if (url.protocol === 'http:') {
    if (!HTTP_HOSTS.has(url.hostname)) {
      return {
        ok: false,
        message: 'Redirect URLs must start with https:// — http is only allowed on localhost in Sandbox.',
      };
    }
    if (!sandbox) {
      return {
        ok: false,
        message: 'Production redirect URLs must start with https:// — http is only allowed on localhost in Sandbox.',
      };
    }
  } else if (url.protocol !== 'https:') {
    return {
      ok: false,
      message: `Redirect URLs must start with https:// — that one starts with "${url.protocol.replace(/:$/, '')}".`,
    };
  }

  if (!url.hostname) {
    return {
      ok: false,
      message: 'That redirect URL has no host name. It should look like https://your-tunnel.trycloudflare.com/oauth.',
    };
  }

  // Tested against the raw text as well as the parsed URL, so a bare trailing
  // "?" or "#" — which parse to an empty search and hash — is caught too.
  if (url.search || trimmed.includes('?')) {
    return {
      ok: false,
      message: 'Plaid rejects redirect URLs with a query string. Delete everything from the "?" onwards.',
    };
  }
  if (url.hash || trimmed.includes('#')) {
    return {
      ok: false,
      message: 'Plaid rejects redirect URLs with a "#" fragment. Delete everything from the "#" onwards.',
    };
  }

  return { ok: true, value: trimmed };
}

// --- Credentials, set at runtime -------------------------------------------
//
// The setup form in the app posts the two keys to POST /api/plaid/credentials
// rather than making the user edit .env by hand. That endpoint persists them
// (server/env-file.js) and calls applyCredentials() so this process picks them
// up immediately — no dev-server restart.

/** Last five characters of a key: enough to recognise, useless to anyone else. */
const tailOf = (value) => (typeof value === 'string' && value ? value.slice(-5) : '');

/**
 * A masked hint at the keys in use, e.g. { clientIdTail: '0b673', secretTail: 'ccde1' },
 * so the UI can show *which* credentials are loaded. Empty strings when unset.
 * This is the only credential-shaped thing that may leave the process.
 */
export function credentialHint() {
  const { clientId, secret } = plaidSettings();
  return { clientIdTail: tailOf(clientId), secretTail: tailOf(secret) };
}

/**
 * Point this process at a different set of Plaid credentials.
 *
 * Both module caches have to be dropped: `settings` memoises the old keys, and
 * `client` is an axios stack with the old keys baked into its default headers.
 * Nulling them makes the next getClient() rebuild from the new values.
 *
 * Validation here is a backstop — the route does the friendly, specific
 * checking — and it never puts a submitted value in a thrown message.
 */
export function applyCredentials({ clientId, secret, env, redirectUri } = {}) {
  const nextClientId = typeof clientId === 'string' ? clientId.trim() : '';
  const nextSecret = typeof secret === 'string' ? secret.trim() : '';
  const nextEnv = (typeof env === 'string' ? env : '').trim().toLowerCase();

  if (!nextClientId || !nextSecret) {
    throw new ApiError(400, 'INVALID_CREDENTIALS', 'A Plaid client ID and secret are both required.');
  }
  if (/[\s"']/.test(nextClientId) || /[\s"']/.test(nextSecret)) {
    throw new ApiError(400, 'INVALID_CREDENTIALS', 'Plaid keys contain no spaces or quotes — check for a stray character.');
  }
  if (!KNOWN_ENVS.includes(nextEnv)) {
    throw new ApiError(400, 'INVALID_CREDENTIALS', 'Choose either the sandbox or the production environment.');
  }

  // Checked against the environment being applied, not the one already loaded:
  // http://localhost is fine in Sandbox and not in Production, so a switch from
  // one to the other has to re-judge the redirect URL that comes with it.
  const redirect = validateRedirectUri(redirectUri, nextEnv);
  if (!redirect.ok) throw new ApiError(400, 'INVALID_REDIRECT_URI', redirect.message);

  process.env.PLAID_CLIENT_ID = nextClientId;
  process.env.PLAID_SECRET = nextSecret;
  process.env.PLAID_ENV = nextEnv;
  // Callers pass the URI they want in force, so an absent or empty one clears
  // the variable outright rather than leaving a blank string behind for
  // plaidSettings() (and any child process) to trip over.
  if (redirect.value) process.env.PLAID_REDIRECT_URI = redirect.value;
  else delete process.env.PLAID_REDIRECT_URI;

  settings = null;
  client = null;

  const applied = plaidSettings();
  return { env: applied.env, redirectUri: applied.redirectUri, ...credentialHint() };
}

/**
 * The four Plaid variables exactly as they stand, `undefined` included, so a
 * failed save can be rolled back to the state before it — redirect URI too,
 * since a bad one is one of the things a save can fail on.
 */
export function snapshotCredentials() {
  return {
    PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID,
    PLAID_SECRET: process.env.PLAID_SECRET,
    PLAID_ENV: process.env.PLAID_ENV,
    PLAID_REDIRECT_URI: process.env.PLAID_REDIRECT_URI,
  };
}

/** Undo applyCredentials(): restore the variables (deleting ones that were unset) and drop both caches. */
export function restoreCredentials(snapshot) {
  for (const [name, value] of Object.entries(snapshot ?? {})) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  settings = null;
  client = null;
}

const ACCESS_TOKEN_PATTERN = /access-(?:sandbox|production|development)-[A-Za-z0-9-]+/gi;

/** Strip anything secret out of a string before it is logged or returned. */
export function redact(text) {
  if (typeof text !== 'string' || text === '') return text;

  const { clientId, secret } = plaidSettings();
  let out = text;
  for (const value of [secret, clientId]) {
    if (value && value.length >= 8) out = out.split(value).join('[redacted]');
  }
  return out.replace(ACCESS_TOKEN_PATTERN, 'access-[redacted]');
}

/**
 * Turn anything thrown during a request into { status, code, message, plaidType }.
 * Plaid errors arrive as axios errors whose response body is a PlaidError; the
 * axios error itself carries the request config (and therefore our headers), so
 * we rebuild a fresh object rather than passing any of it through.
 */
export function describeError(err) {
  if (err instanceof ApiError) {
    return { status: err.status, code: err.code, message: err.message };
  }

  const body = err?.response?.data;
  if (body && typeof body === 'object' && typeof body.error_code === 'string') {
    const raw = Number(err.response.status);
    return {
      status: Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 400,
      code: body.error_code,
      message: redact(body.display_message || body.error_message || 'Plaid rejected the request.'),
      plaidType: typeof body.error_type === 'string' ? body.error_type : undefined,
    };
  }

  // Body parser rejected the JSON we were sent.
  if (err?.type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'That request body was not valid JSON.' };
  }

  // Couldn't reach Plaid at all — offline, DNS, TLS, timeout.
  if (typeof err?.code === 'string' && /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_BAD_RESPONSE|ECONNABORTED)$/.test(err.code)) {
    return {
      status: 502,
      code: 'PLAID_UNREACHABLE',
      message: `Couldn't reach Plaid (${err.code}). Check your connection and try again.`,
    };
  }

  return {
    status: 500,
    code: 'SERVER_ERROR',
    message: redact(err?.message) || 'Something went wrong on the Plaid backend.',
  };
}

// --- DTO mapping -----------------------------------------------------------
// These shapes must match PlaidAccountDto / PlaidTransactionDto in src/lib/plaid.ts.

/**
 * Plaid returns balances.current as a positive number owed for credit accounts,
 * which is exactly what the client wants, so it passes straight through. A few
 * institutions return null; derive what we can rather than reporting nothing.
 */
function currentBalance(account) {
  const balances = account.balances ?? {};
  if (typeof balances.current === 'number') return balances.current;
  if (account.type === 'credit' && typeof balances.limit === 'number' && typeof balances.available === 'number') {
    return balances.limit - balances.available;
  }
  return typeof balances.available === 'number' ? balances.available : 0;
}

export function toAccountDto(account, institutionName, itemId) {
  const balances = account.balances ?? {};
  const dto = {
    accountId: account.account_id,
    name: account.name,
    mask: account.mask ?? '',
    type: account.type,
    balanceCurrent: currentBalance(account),
    institutionName,
    itemId,
  };

  if (account.official_name) dto.officialName = account.official_name;
  if (account.subtype) dto.subtype = account.subtype;
  if (typeof balances.available === 'number') dto.balanceAvailable = balances.available;
  if (account.type === 'credit' && typeof balances.limit === 'number') dto.creditLimit = balances.limit;

  return dto;
}

export function toTransactionDto(transaction) {
  const dto = {
    transactionId: transaction.transaction_id,
    accountId: transaction.account_id,
    date: transaction.date,
    name: transaction.name ?? '',
    // Plaid's sign convention, untouched: positive = money out. The client maps it.
    amount: transaction.amount,
    pending: Boolean(transaction.pending),
  };

  if (transaction.merchant_name) dto.merchantName = transaction.merchant_name;

  const pfc = transaction.personal_finance_category;
  if (pfc?.primary) dto.pfcPrimary = pfc.primary;
  if (pfc?.detailed) dto.pfcDetailed = pfc.detailed;

  return dto;
}

// --- Plaid calls -----------------------------------------------------------

/**
 * Link token request shared by first-time linking and update mode.
 *
 * redirect_uri belongs on both: an OAuth bank navigates the page away when it
 * is being repaired in update mode just as it does on the first link, so a
 * token without it would strand the user at the bank. What must *not* differ is
 * the rest of the shape — update mode still carries an access_token and no
 * products, which the caller sets.
 */
export function baseLinkTokenRequest(clientUserId) {
  const request = {
    client_name: 'Finch',
    language: 'en',
    country_codes: [CountryCode.Us],
    user: { client_user_id: clientUserId },
  };

  const { redirectUri } = plaidSettings();
  if (redirectUri) request.redirect_uri = redirectUri;

  return request;
}

export const TRANSACTIONS_PRODUCT = Products.Transactions;
export const US = CountryCode.Us;

/**
 * The institution behind an access token. Plaid usually puts the name straight
 * on the item; when it doesn't, look it up. Neither call is worth failing a
 * link over, so both fall back to 'Bank'.
 */
export async function resolveInstitution(plaid, accessToken) {
  try {
    const { data } = await plaid.itemGet({ access_token: accessToken });
    const institutionId = data.item.institution_id ?? null;

    if (data.item.institution_name) {
      return { institutionName: data.item.institution_name, institutionId };
    }

    if (institutionId) {
      try {
        const found = await plaid.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
        });
        return { institutionName: found.data.institution.name, institutionId };
      } catch (err) {
        console.warn(`[plaid] institution ${institutionId} lookup failed: ${describeError(err).message}`);
      }
    }

    return { institutionName: 'Bank', institutionId };
  } catch (err) {
    console.warn(`[plaid] item lookup failed: ${describeError(err).message}`);
    return { institutionName: 'Bank', institutionId: null };
  }
}

/** Plaid's documented maximum page size for /transactions/sync. */
const PAGE_SIZE = 500;
/** Belt and braces: 400 pages x 500 is 200k updates, far past any real item. */
const MAX_PAGES = 400;
/** Restart budget for the mutation-during-pagination race. */
const MAX_ATTEMPTS = 3;

/**
 * Page through /transactions/sync from the stored cursor until has_more is false.
 *
 * Plaid can invalidate a pagination run if the underlying data changes mid-pass
 * (TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION). The documented fix is to throw
 * away the partial results and start again from the last *persisted* cursor,
 * which is what the outer loop does — the caller only persists next_cursor once
 * a full pass has come back clean.
 */
export async function pullTransactions(plaid, accessToken, startCursor) {
  for (let attempt = 1; ; attempt += 1) {
    const added = [];
    const modified = [];
    const removed = [];
    let cursor = startCursor || undefined;

    try {
      for (let page = 0; ; page += 1) {
        if (page >= MAX_PAGES) {
          throw new ApiError(500, 'SYNC_TOO_LARGE', 'Plaid kept paginating past 200,000 updates. Sync stopped.');
        }

        const request = { access_token: accessToken, count: PAGE_SIZE };
        if (cursor) request.cursor = cursor;

        const { data } = await plaid.transactionsSync(request);

        for (const transaction of data.added) added.push(toTransactionDto(transaction));
        for (const transaction of data.modified) modified.push(toTransactionDto(transaction));
        for (const record of data.removed) removed.push(record.transaction_id);

        cursor = data.next_cursor;
        if (!data.has_more) break;
      }

      return { added, modified, removed, nextCursor: cursor ?? '' };
    } catch (err) {
      const info = describeError(err);
      if (info.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < MAX_ATTEMPTS) {
        console.warn(`[plaid] transactions changed mid-pagination; restarting pass ${attempt + 1} of ${MAX_ATTEMPTS}`);
        continue;
      }
      throw err;
    }
  }
}
