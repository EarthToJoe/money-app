// Loads Plaid's Link SDK exactly once per page, no matter how many times this
// module is evaluated.
//
// Why this exists: react-plaid-link's `usePlaidLink` injects
// link-initialize.js when the hook mounts. React StrictMode mounts every
// effect twice in dev, and a Vite hot-swap re-runs the module while the
// previous <script> is still in the document. Either way Plaid ends up with
// two controllers driving one iframe: Link renders, looks normal, and silently
// swallows every click — including its own close button and "Continue to
// login". Plaid warns about this in the console ("script was embedded more
// than once ... unpredictable behavior") and it is exactly what we hit.
//
// The guard state lives on `window`, not in a module variable, because a hot
// swap resets module scope but not the DOM — the whole failure mode we're
// fixing.

const SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
const SELECTOR = 'script[data-finch-plaid], script[src*="link-initialize.js"]';
const KEY = '__finchPlaidScript__';

export interface PlaidHandler {
  open: () => void;
  exit: (options?: { force?: boolean }) => void;
  destroy: () => void;
}

export interface PlaidLinkOnExitError {
  error_code?: string;
  error_message?: string;
  display_message?: string;
}

interface PlaidGlobal {
  create: (config: {
    token: string;
    /**
     * Set only on the OAuth return page: `window.location.href` exactly as the
     * bank sent it back (it carries `oauth_state_id`). With it, and the SAME
     * token the flow started with, Link resumes the in-flight session instead
     * of starting a new one.
     */
    receivedRedirectUri?: string;
    onSuccess: (publicToken: string, metadata: unknown) => void;
    onExit: (error: PlaidLinkOnExitError | null, metadata: unknown) => void;
    onLoad?: () => void;
    onEvent?: (eventName: string, metadata: unknown) => void;
  }) => PlaidHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidGlobal;
    [KEY]?: Promise<PlaidGlobal>;
  }
}

/** How many copies of Plaid's SDK are in the document — should always be 0 or 1. */
export function plaidScriptCount(): number {
  return document.querySelectorAll(SELECTOR).length;
}

/** Resolves with window.Plaid, loading the SDK on first call and reusing it after. */
export function loadPlaid(): Promise<PlaidGlobal> {
  if (window.Plaid) return Promise.resolve(window.Plaid);

  const inFlight = window[KEY];
  if (inFlight) return inFlight;

  const promise = new Promise<PlaidGlobal>((resolve, reject) => {
    const settle = () => {
      if (window.Plaid) resolve(window.Plaid);
      else reject(new Error("Plaid's SDK loaded but did not initialise."));
    };
    const fail = () =>
      reject(new Error("Couldn't load Plaid Link. Check your connection and try again."));

    // A tag may already be present from a previous module evaluation.
    const existing = document.querySelector<HTMLScriptElement>(SELECTOR);
    if (existing) {
      if (window.Plaid) return resolve(window.Plaid);
      existing.addEventListener('load', settle, { once: true });
      existing.addEventListener('error', fail, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = SRC;
    script.async = true;
    script.dataset.finchPlaid = 'true';
    script.addEventListener('load', settle, { once: true });
    script.addEventListener('error', fail, { once: true });
    document.head.appendChild(script);
  });

  // Cache on window so a hot swap reuses it instead of injecting a second copy.
  window[KEY] = promise;
  promise.catch(() => {
    // Let a later attempt retry after a network failure.
    if (window[KEY] === promise) delete window[KEY];
  });
  return promise;
}
