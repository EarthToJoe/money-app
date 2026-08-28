// The handoff across Plaid's OAuth full-page navigation.
//
// Most large US banks (Chase, Capital One, Bank of America, Schwab, PNC, US
// Bank) use Plaid's OAuth flow: Link doesn't take the credentials itself, it
// navigates the WHOLE PAGE to the bank's site. When the bank sends the browser
// back to our registered redirect URI (https://<host>/oauth), the app has been
// torn down and rebuilt from scratch — React state, the open modal, the Link
// handler, all gone.
//
// Plaid's rule for resuming is: re-create Link with THE SAME link_token that
// opened the flow, plus `receivedRedirectUri`. So the token has to outlive the
// navigation, which means storage. sessionStorage is the right shelf: it is
// scoped to this one tab, it survives navigations within the tab (including
// the trip to the bank and back), and it is gone when the tab closes.
//
// WHAT MAY BE STORED HERE: a Plaid **link token** and the item id being
// repaired. Nothing else, ever. Not the Plaid secret, not an access token, not
// a public token — the browser never holds those (the backend does), and this
// module must not become the place someone decides to stash one.

/** A Link session that was open when the page navigated to the bank. */
export interface PendingLink {
  /** The link_token the flow was opened with — Link needs the same one to resume. */
  token: string;
  /** Set when the flow is Link update mode repairing an existing item. */
  itemId?: string;
  /** Epoch ms, so a token left behind by an abandoned flow can expire. */
  startedAt: number;
}

const KEY = 'finch.plaid.pendingLink';

/** Set to the institution name right after a link so Accounts can confirm it. */
const JUST_LINKED_KEY = 'finch.plaid.justLinked';

/**
 * Plaid link tokens expire (4 hours for a new link, 30 minutes once a flow is
 * in progress). Past this we'd resume into an INVALID_LINK_TOKEN error, which
 * reads as a broken app — better to say "start again".
 */
const MAX_AGE_MS = 30 * 60 * 1000;

/** sessionStorage throws in Safari private mode and when storage is disabled. */
function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function savePendingLink(pending: PendingLink): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      KEY,
      JSON.stringify({
        token: pending.token,
        ...(pending.itemId ? { itemId: pending.itemId } : {}),
        startedAt: pending.startedAt,
      } satisfies PendingLink),
    );
  } catch {
    // Quota or a locked-down browser: the OAuth round-trip won't resume, and
    // /oauth will say so rather than silently hanging.
  }
}

/** The in-flight Link session, or null when there is none, it's unreadable, or it's stale. */
export function readPendingLink(): PendingLink | null {
  const store = storage();
  if (!store) return null;

  let raw: string | null = null;
  try {
    raw = store.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearPendingLink();
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    clearPendingLink();
    return null;
  }

  const { token, itemId, startedAt } = parsed as Partial<PendingLink>;
  if (typeof token !== 'string' || !token.trim()) {
    clearPendingLink();
    return null;
  }

  const started = typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : 0;
  // A missing/garbled timestamp counts as stale: we can't tell how old the token is.
  if (started <= 0 || Date.now() - started > MAX_AGE_MS) {
    clearPendingLink();
    return null;
  }

  return {
    token: token.trim(),
    ...(typeof itemId === 'string' && itemId ? { itemId } : {}),
    startedAt: started,
  };
}

export function clearPendingLink(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(KEY);
  } catch {
    /* nothing we can do, and nothing depends on it */
  }
}

/**
 * True on the page the bank redirects back to. The path is fixed — it is the
 * exact string registered with Plaid ("https://<host>/oauth"), so it must not
 * be a hash route: the bank redirects to a URL, and everything after '#' never
 * reaches a redirect allowlist match.
 */
export function isOAuthReturn(): boolean {
  const path = window.location.pathname;
  // Tolerate the trailing slash some redirect chains add.
  return path === '/oauth' || path === '/oauth/';
}

/** Remember which bank just linked, for the confirmation on the other side of the reload. */
export function setJustLinked(institutionName: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(JUST_LINKED_KEY, institutionName || 'your bank');
  } catch {
    /* the confirmation line is a nicety, not the outcome */
  }
}

/** Reads and clears the flag — a confirmation should show once, not on every mount. */
export function takeJustLinked(): string | null {
  const store = storage();
  if (!store) return null;
  try {
    const value = store.getItem(JUST_LINKED_KEY);
    if (value === null) return null;
    store.removeItem(JUST_LINKED_KEY);
    return value.trim() || null;
  } catch {
    return null;
  }
}
