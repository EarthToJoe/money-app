import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../../store';
import {
  BACKEND_DOWN,
  createLinkToken,
  fetchPlaidStatus,
  finishLink,
  removeItem,
  saveCredentials,
  saveRedirectUri,
  type PlaidItemSummary,
  type PlaidStatus,
} from '../../lib/plaid';
import { clearPendingLink, savePendingLink, takeJustLinked } from '../../lib/oauthResume';
import { Modal } from './Modal';
import { LinkButton } from './LinkButton';
import { errText, plural, runSync, summarizeSync } from './sync';

interface Props {
  onClose: () => void;
  onImportCsv: () => void;
}

const SIGNUP_URL = 'https://dashboard.plaid.com/signup';
const KEYS_URL = 'https://dashboard.plaid.com/developers/keys';

/** idle → token (asking the backend) → linking (Link is open) → importing (exchange + first sync) */
type Phase = 'idle' | 'token' | 'linking' | 'importing';

type ItemJob = { itemId: string; kind: 'sync' | 'unlink' };

type KeyEnv = 'sandbox' | 'production';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 'var(--fs-xs)',
  fontWeight: 650,
  color: 'var(--ink-2)',
  marginBottom: 5,
};

const errorBannerStyle: CSSProperties = {
  color: 'var(--critical)',
  background: 'rgba(208, 59, 59, 0.08)',
  borderColor: 'rgba(208, 59, 59, 0.25)',
};

const truncatedStyle: CSSProperties = {
  fontFamily: MONO,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** Hosts Plaid accepts without HTTPS — everything else has to come through the tunnel. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/** True when `uri` is a URL we can parse and it lives on `origin`. */
function isOnOrigin(uri: string | undefined, origin: string): boolean {
  if (!uri) return false;
  try {
    return new URL(uri).origin === origin;
  } catch {
    return false;
  }
}

export function ConnectBankModal({ onClose, onImportCsv }: Props) {
  const accounts = useApp((s) => s.accounts);
  const transactions = useApp((s) => s.transactions);
  const applySync = useApp((s) => s.applySync);
  const removeAccount = useApp((s) => s.removeAccount);
  const loadDemoData = useApp((s) => s.loadDemoData);

  const [status, setStatus] = useState<PlaidStatus | null>(null);
  const [checking, setChecking] = useState(true);

  const [phase, setPhase] = useState<Phase>('idle');
  const [linkToken, setLinkToken] = useState<string | null>(null);
  /** Set while re-authenticating an existing item (Link update mode). */
  const [repairing, setRepairing] = useState<PlaidItemSummary | null>(null);
  const [job, setJob] = useState<ItemJob | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // --- Setup form (the in-app replacement for hand-editing .env) ------------
  // The secret lives in this component's state only while the user is typing
  // it and until the POST resolves — it is never written to the zustand store,
  // localStorage, a URL or the console. It goes to the local backend and stops.
  const [clientIdInput, setClientIdInput] = useState('');
  const [secretInput, setSecretInput] = useState('');
  const [keyEnv, setKeyEnv] = useState<KeyEnv>('sandbox');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTails, setSavedTails] = useState<{ clientIdTail: string; secretTail: string } | null>(null);
  /** Set when the user reopens the form via "Change keys" while already configured. */
  const [editingKeys, setEditingKeys] = useState(false);

  // --- OAuth redirect URL ---------------------------------------------------
  // Chase, Capital One, Bank of America, Schwab and most other large banks only
  // do OAuth: Link navigates the whole page to the bank, and the bank returns
  // the browser to this exact URL. Plaid rejects the link token unless the
  // string is registered in the dashboard, so it is a real field, not a detail.
  /** The field inside the credentials form (production only). */
  const [redirectInput, setRedirectInput] = useState('');
  /** The inline editor in the configured state. */
  const [editingRedirect, setEditingRedirect] = useState(false);
  const [redirectEdit, setRedirectEdit] = useState('');
  const [redirectSaving, setRedirectSaving] = useState(false);
  const [redirectError, setRedirectError] = useState<string | null>(null);

  /** Set by the /oauth page just before it bounced the browser back here. */
  const [justLinked, setJustLinked] = useState<string | null>(null);
  useEffect(() => {
    // In an effect, not a state initializer: this read has a side effect (it
    // clears the flag), and StrictMode double-invokes initializers.
    const name = takeJustLinked();
    if (name) setJustLinked(name);
  }, []);

  const origin = window.location.origin;
  /** Serving from a tunnel host means this origin is the one banks can reach. */
  const servedRemotely = !isLocalHost(window.location.hostname);
  const suggestedRedirect = `${origin}/oauth`;

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const next = await fetchPlaidStatus();
      setStatus(next);
      // Prefill the form field with whatever is already saved, but never
      // overwrite something the user has typed.
      setRedirectInput((cur) => (cur.trim() ? cur : (next.redirectUri ?? '')));
    } catch (e) {
      setStatus({
        configured: false,
        reachable: false,
        env: 'unknown',
        items: [],
        message: errText(e, 'The status check failed.'),
      });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const busy = phase !== 'idle' || job !== null || saving || redirectSaving;

  const reachable = status?.reachable ?? false;
  const configured = status?.configured ?? false;
  const env = status?.env ?? 'unknown';
  const items = status?.items ?? [];
  const redirectUri = status?.redirectUri ?? '';
  /**
   * The page is being served through a tunnel but the saved redirect URL isn't
   * on that host — so every OAuth bank would either be rejected by Plaid or
   * send the user back to a URL that no longer exists.
   */
  const redirectMismatch = servedRemotely && !isOnOrigin(redirectUri, origin);

  // --- Link ----------------------------------------------------------------

  const startLink = async (item?: PlaidItemSummary) => {
    setError(null);
    setResult(null);
    setRepairing(item ?? null);
    setPhase('token');
    try {
      // With an item, the backend returns an update-mode token that repairs it.
      const token = await createLinkToken(item?.itemId);
      if (!token) throw new Error('The backend returned an empty Link token.');
      // Before Link opens, not after: picking an OAuth bank navigates the whole
      // page away, and this component (with the token in its state) is gone.
      // /oauth resumes the flow from what's stored here. See lib/oauthResume.ts.
      savePendingLink({ token, ...(item ? { itemId: item.itemId } : {}), startedAt: Date.now() });
      setLinkToken(token);
      setPhase('linking');
    } catch (e) {
      setError(errText(e, 'Could not start Plaid Link.'));
      setRepairing(null);
      setPhase('idle');
    }
  };

  const onLinked = useCallback(
    async (publicToken: string) => {
      setLinkToken(null);
      // Link finished here, in this tab: nothing left to resume at /oauth.
      clearPendingLink();
      setPhase('importing');
      try {
        if (repairing) {
          // Update mode returns a public token that must not be exchanged — the
          // stored access token is still the right one, it just works again now.
          const totals = await runSync(applySync, repairing.itemId);
          setResult(`Reconnected ${repairing.institutionName} — ${summarizeSync(totals).toLowerCase()}.`);
        } else {
          // Shared with the /oauth page (lib/plaid.ts) so a bank linked either
          // way lands in the store identically.
          const linked = await finishLink(publicToken, applySync, runSync);
          setResult(
            `Linked ${linked.institutionName} — ${plural(linked.accountCount, 'account')}, ${plural(linked.txnsAdded, 'transaction')} imported.`,
          );
        }
      } catch (e) {
        setError(errText(e, 'The bank linked, but importing its data failed. Try Sync.'));
      } finally {
        setRepairing(null);
        setPhase('idle');
        void refresh();
      }
    },
    [applySync, refresh, repairing],
  );

  const onCancelled = useCallback((message: string | null) => {
    setLinkToken(null);
    // The token dies with the closed flow — don't leave it for /oauth to retry.
    clearPendingLink();
    setRepairing(null);
    setPhase('idle');
    if (message) setError(message);
  }, []);

  // --- Per-item actions ----------------------------------------------------

  const syncOne = async (item: PlaidItemSummary) => {
    setError(null);
    setResult(null);
    setJob({ itemId: item.itemId, kind: 'sync' });
    try {
      const totals = await runSync(applySync, item.itemId);
      setResult(`${item.institutionName} — ${summarizeSync(totals).toLowerCase()}.`);
      await refresh();
    } catch (e) {
      setError(errText(e, `Could not sync ${item.institutionName}.`));
    } finally {
      setJob(null);
    }
  };

  const unlink = async (item: PlaidItemSummary) => {
    const local = accounts.filter((a) => a.id.startsWith('plaid:') && a.institution === item.institutionName);
    const txnCount = transactions.filter((t) => local.some((a) => a.id === t.accountId)).length;
    const ok = window.confirm(
      `Unlink ${item.institutionName}?\n\nThis removes the connection at Plaid and deletes ${plural(local.length, 'account')} and ${plural(txnCount, 'transaction')} from Finch. Budgets are kept, and you can link the bank again any time.`,
    );
    if (!ok) return;

    setError(null);
    setResult(null);
    setJob({ itemId: item.itemId, kind: 'unlink' });
    try {
      await removeItem(item.itemId);
      for (const a of local) removeAccount(a.id);
      setResult(`Unlinked ${item.institutionName} · ${plural(local.length, 'account')} removed.`);
      await refresh();
    } catch (e) {
      setError(errText(e, `Could not unlink ${item.institutionName}.`));
    } finally {
      setJob(null);
    }
  };

  // --- Fallbacks -----------------------------------------------------------

  const loadDemo = () => {
    const hasImported = transactions.some((t) => t.source !== 'demo');
    if (
      hasImported &&
      !window.confirm('Loading the demo set replaces your current accounts and transactions, including anything you imported. Continue?')
    ) {
      return;
    }
    loadDemoData();
    onClose();
  };

  // --- Saving the keys -----------------------------------------------------

  const trimmedClientId = clientIdInput.trim();
  const trimmedSecret = secretInput.trim();
  const trimmedRedirect = redirectInput.trim();
  const canSave = trimmedClientId !== '' && trimmedSecret !== '' && !saving;

  const saveKeys = async () => {
    if (!canSave) return;
    setSaveError(null);
    setError(null);
    setResult(null);
    setSavedTails(null);
    setSaving(true);
    try {
      // Trimmed: people paste with a trailing space or newline.
      const res = await saveCredentials({
        clientId: trimmedClientId,
        secret: trimmedSecret,
        env: keyEnv,
        // Only production needs one: Plaid allows plain http://localhost in
        // sandbox, so a redirect URL there is noise the backend can ignore.
        ...(keyEnv === 'production' && trimmedRedirect ? { redirectUri: trimmedRedirect } : {}),
      });

      // Drop the secret from state the moment the backend has it.
      setSecretInput('');
      setClientIdInput('');
      setShowSecret(false);
      setSavedTails({ clientIdTail: res.clientIdTail, secretTail: res.secretTail });
      setEditingKeys(false);
      setSaving(false);

      // The backend reloaded its Plaid client in-process, so the app is
      // configured right now — pick up the new status and open Link straight
      // away rather than making the user press Connect again.
      await refresh();
      await startLink();
    } catch (e) {
      // Verbatim backend message, fields untouched so the user can fix and retry.
      setSaveError(errText(e, 'Could not save the keys.'));
      setSaving(false);
    }
  };

  const openKeyForm = () => {
    setEditingKeys(true);
    setSaveError(null);
    setSavedTails(null);
    setError(null);
    setResult(null);
    setShowSecret(false);
    setKeyEnv(env === 'production' ? 'production' : 'sandbox');
    setRedirectInput(redirectUri);
  };

  const closeKeyForm = () => {
    setEditingKeys(false);
    setSaveError(null);
    setClientIdInput('');
    setSecretInput('');
    setShowSecret(false);
  };

  // --- Saving just the redirect URL ----------------------------------------
  //
  // Its own endpoint because it changes far more often than the keys do: every
  // `npm run tunnel` hands out a new hostname, and re-pasting a production
  // secret to change one URL would be absurd.

  const openRedirectForm = () => {
    setEditingRedirect(true);
    setRedirectError(null);
    setError(null);
    setResult(null);
    // Start from what's saved, or from this origin when we're on the tunnel and
    // the saved value can't be right anyway.
    setRedirectEdit(redirectUri || (servedRemotely ? suggestedRedirect : ''));
  };

  const closeRedirectForm = () => {
    setEditingRedirect(false);
    setRedirectError(null);
    setRedirectEdit('');
  };

  const submitRedirect = async () => {
    const value = redirectEdit.trim();
    if (!value || redirectSaving) return;
    setRedirectError(null);
    setError(null);
    setResult(null);
    setRedirectSaving(true);
    try {
      const saved = await saveRedirectUri(value);
      setEditingRedirect(false);
      setRedirectEdit('');
      setRedirectInput(saved.redirectUri);
      setResult(
        `OAuth redirect URL set to ${saved.redirectUri}. Register that exact string in the Plaid dashboard under Developers → API → Allowed redirect URIs.`,
      );
      await refresh();
    } catch (e) {
      // Verbatim: REDIRECT_URI_NOT_REGISTERED names the exact string to paste
      // into the dashboard, and paraphrasing it would lose that.
      setRedirectError(errText(e, 'Could not save the redirect URL.'));
    } finally {
      setRedirectSaving(false);
    }
  };

  // --- Render --------------------------------------------------------------

  /** The keys form owns the modal both before setup and when changing keys. */
  const showKeyForm = reachable && (!configured || editingKeys);

  const subtitle = !status
    ? 'Checking the backend'
    : !reachable
      ? 'Backend offline'
      : editingKeys
        ? 'Change your Plaid keys'
        : !configured
          ? 'One-time setup'
          : env === 'production'
            ? 'Live bank sync'
            : 'Sandbox bank sync';

  return (
    <Modal title="Connect a bank" subtitle={subtitle} onClose={onClose} maxWidth={680}>
      {!status && checking && (
        <p className="small muted" role="status">
          Checking the Plaid backend…
        </p>
      )}

      {/* Set by /oauth on the way back from a bank's OAuth sign-in, which
          reloads the app — this is the only place that news survives to. */}
      {justLinked && (
        <div className="row" style={{ marginBottom: 14, gap: 8, alignItems: 'flex-start' }} role="status">
          <span className="badge badge-good" style={{ flex: 'none' }}>
            Connected {justLinked}
          </span>
          <span className="small" style={{ color: 'var(--ink-2)' }}>
            The bank sign-in finished and its accounts are in Finch.
          </span>
        </div>
      )}

      {error && (
        <div className="row" style={{ marginBottom: 14, gap: 8, alignItems: 'flex-start' }}>
          <span className="badge badge-bad" style={{ flex: 'none' }}>
            Error
          </span>
          <span className="small" style={{ color: 'var(--critical)' }}>
            {error}
          </span>
        </div>
      )}
      {result && !error && (
        <div className="row" style={{ marginBottom: 14, gap: 8, alignItems: 'flex-start' }}>
          <span className="badge badge-good" style={{ flex: 'none' }}>
            Done
          </span>
          <span className="small" style={{ color: 'var(--ink-2)' }}>
            {result}
          </span>
        </div>
      )}
      {savedTails && (
        <div className="row" style={{ marginBottom: 14, gap: 8, alignItems: 'flex-start' }} role="status">
          <span className="badge badge-good" style={{ flex: 'none' }}>
            Done
          </span>
          <span className="small" style={{ color: 'var(--ink-2)', lineHeight: 1.6 }}>
            {tailsLabel(savedTails)}. Written to <Code>.env</Code> on this machine — no restart needed.
          </span>
        </div>
      )}

      {status && !reachable && (
        <div>
          <div className="banner" style={errorBannerStyle}>
            The Plaid backend isn&rsquo;t running.
          </div>
          <p className="small" style={{ marginTop: 12, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            Run <Code>npm run dev</Code> (it starts the web app and the backend together). Everything else in Finch keeps
            working without it — demo data and CSV imports are local.
          </p>
          {/* The banner above already says the backend is down — only show a message that adds something. */}
          {status.message && status.message !== BACKEND_DOWN && (
            <p className="small muted" style={{ marginTop: 8 }}>
              {status.message}
            </p>
          )}

          <div className="spread" style={{ marginTop: 20, flexWrap: 'wrap', gap: 10 }}>
            <button className="btn btn-ghost" onClick={onImportCsv} style={{ whiteSpace: 'nowrap' }}>
              Import CSV instead
            </button>
            <div className="row" style={{ flex: 'none' }}>
              <button className="btn" onClick={loadDemo} style={{ whiteSpace: 'nowrap' }}>
                Load demo accounts
              </button>
              <button className="btn btn-primary" onClick={() => void refresh()} disabled={checking} style={{ whiteSpace: 'nowrap' }}>
                {checking ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          </div>
        </div>
      )}

      {status && showKeyForm && (
        <div>
          <div className="card-title" style={{ marginBottom: 4 }}>
            {editingKeys ? 'Paste your new keys' : 'Paste your Plaid keys'}
          </div>
          <p className="small" style={{ color: 'var(--ink-2)', lineHeight: 1.6 }}>
            Paste the two keys below and Finch saves them on this machine for you — no file to edit, nothing to restart.
          </p>

          <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
            <Step n={1} title="Create a free Plaid account">
              <ExternalLink href={SIGNUP_URL}>dashboard.plaid.com/signup</ExternalLink>
              {' — no card, no approval wait.'}
            </Step>

            <Step n={2} title="Copy your keys">
              On <ExternalLink href={KEYS_URL}>dashboard.plaid.com/developers/keys</ExternalLink> copy two things: your{' '}
              <strong>Client ID</strong> and your{' '}
              <strong>{keyEnv === 'production' ? 'Production secret' : 'Sandbox secret'}</strong>.
            </Step>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveKeys();
            }}
            style={{ display: 'grid', gap: 14, marginTop: 18 }}
          >
            <div>
              <label htmlFor="plaid-client-id" style={fieldLabelStyle}>
                Client ID
              </label>
              <input
                id="plaid-client-id"
                className="input"
                type="text"
                value={clientIdInput}
                onChange={(e) => setClientIdInput(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                disabled={saving}
                placeholder={status.clientIdTail ? `Currently …${status.clientIdTail}` : undefined}
                style={{ width: '100%', fontFamily: MONO }}
              />
            </div>

            <div>
              <label htmlFor="plaid-secret" style={fieldLabelStyle}>
                {keyEnv === 'production' ? 'Production secret' : 'Sandbox secret'}
              </label>
              <div className="row" style={{ gap: 8 }}>
                <input
                  id="plaid-secret"
                  className="input"
                  type={showSecret ? 'text' : 'password'}
                  value={secretInput}
                  onChange={(e) => setSecretInput(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  disabled={saving}
                  placeholder={status.secretTail ? `Currently …${status.secretTail}` : undefined}
                  style={{ flex: 1, fontFamily: MONO }}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowSecret((v) => !v)}
                  aria-label={showSecret ? 'Hide secret' : 'Show secret'}
                  aria-pressed={showSecret}
                  style={{ flex: 'none' }}
                >
                  {showSecret ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div>
              <span style={fieldLabelStyle}>Environment</span>
              <div className="segmented" role="group" aria-label="Plaid environment">
                {(['sandbox', 'production'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={keyEnv === option ? 'active' : ''}
                    aria-pressed={keyEnv === option}
                    onClick={() => setKeyEnv(option)}
                    disabled={saving}
                  >
                    {option === 'sandbox' ? 'Sandbox' : 'Production'}
                  </button>
                ))}
              </div>
              {keyEnv === 'production' ? (
                // A block wrapper: .badge is inline-flex, so on its own it would
                // sit beside the (also inline-flex) segmented control.
                <div style={{ marginTop: 8 }}>
                  <span
                    className="badge badge-warn"
                    style={{ whiteSpace: 'normal', lineHeight: 1.55, padding: '5px 10px' }}
                  >
                    Production reads your real accounts. Plaid&rsquo;s free trial covers 10 banks.
                  </span>
                </div>
              ) : (
                <p className="small muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
                  Sandbox is free forever and uses fake banks — log in with <Code>user_good</Code> /{' '}
                  <Code>pass_good</Code>.
                </p>
              )}
            </div>

            {/* Production-only: without this, every OAuth bank is unreachable.
                Plaid allows http://localhost in sandbox, so the field would be
                dead weight there. */}
            {keyEnv === 'production' && (
              <div>
                <label htmlFor="plaid-redirect-uri" style={fieldLabelStyle}>
                  OAuth redirect URL
                </label>
                <input
                  id="plaid-redirect-uri"
                  className="input"
                  type="url"
                  inputMode="url"
                  value={redirectInput}
                  onChange={(e) => setRedirectInput(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  disabled={saving}
                  placeholder="https://your-tunnel.trycloudflare.com/oauth"
                  style={{ width: '100%', fontFamily: MONO }}
                />
                <p className="small muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
                  Needed for Chase, Capital One, Bank of America and most large banks. Run{' '}
                  <Code>npm run tunnel</Code> to get a URL, then register it in the Plaid dashboard
                  under Developers → API → Allowed redirect URIs.
                </p>
                {redirectMismatch && (
                  <UseThisOrigin
                    url={suggestedRedirect}
                    disabled={saving}
                    onUse={() => setRedirectInput(suggestedRedirect)}
                  />
                )}
              </div>
            )}

            {/* Backend message, verbatim. The fields keep what the user typed. */}
            {saveError && (
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }} role="alert">
                <span className="badge badge-bad" style={{ flex: 'none' }}>
                  Not saved
                </span>
                <span className="small" style={{ color: 'var(--critical)', lineHeight: 1.6 }}>
                  {saveError}
                </span>
              </div>
            )}

            <div className="spread" style={{ marginTop: 4, flexWrap: 'wrap', gap: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={onImportCsv} style={{ whiteSpace: 'nowrap' }}>
                Import CSV instead
              </button>
              <div className="row" style={{ flex: 'none', gap: 8 }}>
                {editingKeys && (
                  <button type="button" className="btn" onClick={closeKeyForm} disabled={saving} style={{ whiteSpace: 'nowrap' }}>
                    Cancel
                  </button>
                )}
                <button type="submit" className="btn btn-primary" disabled={!canSave} style={{ whiteSpace: 'nowrap' }}>
                  {saving ? 'Checking with Plaid…' : 'Save & connect'}
                </button>
              </div>
            </div>
          </form>

          <details style={{ marginTop: 16 }}>
            <summary className="small" style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--ink-2)' }}>
              Where do I find these?
            </summary>
            <div className="small muted" style={{ marginTop: 8, lineHeight: 1.65 }}>
              Sign in at dashboard.plaid.com. In the left sidebar open <strong>Developers</strong>, then{' '}
              <strong>Keys</strong>. The page lists your <strong>Client ID</strong> once at the top, then one secret per
              environment — <strong>Sandbox</strong>, Development and Production — each behind a Reveal or copy button.
              Take the Client ID and the secret on the row matching the environment you picked above.
            </div>
          </details>

          <p className="small muted" style={{ marginTop: 14, lineHeight: 1.6 }}>
            The keys go to Finch&rsquo;s backend on your own machine, which writes them to <Code>.env</Code> (already
            git-ignored). They are never sent anywhere else and never stored in the browser.
          </p>
        </div>
      )}

      {status && reachable && configured && !editingKeys && (
        <div>
          <div className="spread" style={{ gap: 10, flexWrap: 'wrap' }}>
            <div className="row" style={{ gap: 8 }}>
              <span className={`badge ${env === 'production' ? 'badge-good' : 'badge-neutral'}`}>
                {env === 'production' ? 'Production' : env === 'sandbox' ? 'Sandbox' : 'Unknown environment'}
              </span>
              <span className="small muted">
                {items.length === 0 ? 'No banks linked yet' : `${plural(items.length, 'bank')} linked`}
                {status.clientIdTail ? ` · key …${status.clientIdTail}` : ''}
              </span>
            </div>
            <div className="row" style={{ flex: 'none', gap: 4 }}>
              <button className="btn btn-ghost" onClick={openKeyForm} disabled={busy} style={{ whiteSpace: 'nowrap' }}>
                Change keys
              </button>
              <button className="btn btn-ghost" onClick={() => void refresh()} disabled={busy || checking} style={{ flex: 'none' }}>
                {checking ? 'Checking…' : 'Refresh'}
              </button>
            </div>
          </div>

          {/* Where banks send the browser back after an OAuth sign-in. */}
          <div style={{ marginTop: 12 }}>
            {editingRedirect ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitRedirect();
                }}
                style={{ display: 'grid', gap: 8 }}
              >
                <label htmlFor="plaid-redirect-edit" style={fieldLabelStyle}>
                  OAuth redirect URL
                </label>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <input
                    id="plaid-redirect-edit"
                    className="input"
                    type="url"
                    inputMode="url"
                    value={redirectEdit}
                    onChange={(e) => setRedirectEdit(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    disabled={redirectSaving}
                    placeholder="https://your-tunnel.trycloudflare.com/oauth"
                    style={{ flex: '1 1 260px', minWidth: 0, fontFamily: MONO }}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={redirectSaving || !redirectEdit.trim()}
                    style={{ flex: 'none' }}
                  >
                    {redirectSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={closeRedirectForm}
                    disabled={redirectSaving}
                    style={{ flex: 'none' }}
                  >
                    Cancel
                  </button>
                </div>
                <p className="small muted" style={{ lineHeight: 1.6 }}>
                  Register this exact string in the Plaid dashboard under Developers → API → Allowed
                  redirect URIs, or Plaid rejects the link token.
                </p>
                {redirectMismatch && (
                  <UseThisOrigin
                    url={suggestedRedirect}
                    disabled={redirectSaving}
                    onUse={() => setRedirectEdit(suggestedRedirect)}
                  />
                )}
                {/* Verbatim — the backend's message names what to fix. */}
                {redirectError && (
                  <div className="row" style={{ gap: 8, alignItems: 'flex-start' }} role="alert">
                    <span className="badge badge-bad" style={{ flex: 'none' }}>
                      Not saved
                    </span>
                    <span className="small" style={{ color: 'var(--critical)', lineHeight: 1.6 }}>
                      {redirectError}
                    </span>
                  </div>
                )}
              </form>
            ) : (
              <div className="spread" style={{ gap: 10, flexWrap: 'wrap' }}>
                {redirectUri ? (
                  <span className="small muted" style={truncatedStyle} title={redirectUri}>
                    OAuth redirect · {redirectUri}
                  </span>
                ) : env === 'production' ? (
                  <span
                    className="badge badge-warn"
                    style={{ whiteSpace: 'normal', lineHeight: 1.55, padding: '5px 10px' }}
                  >
                    No OAuth redirect URL — Chase, Capital One and most large banks can&rsquo;t open
                  </span>
                ) : (
                  <span className="small muted">
                    No OAuth redirect URL — only Production banks need one
                  </span>
                )}
                <button
                  className="btn btn-ghost"
                  onClick={openRedirectForm}
                  disabled={busy}
                  style={{ flex: 'none', whiteSpace: 'nowrap' }}
                >
                  {redirectUri ? 'Change redirect URL' : 'Add redirect URL'}
                </button>
              </div>
            )}
            {!editingRedirect && redirectMismatch && (
              <UseThisOrigin
                url={suggestedRedirect}
                disabled={busy}
                onUse={() => {
                  openRedirectForm();
                  setRedirectEdit(suggestedRedirect);
                }}
              />
            )}
          </div>

          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => void startLink()} disabled={busy}>
              {phase === 'token'
                ? 'Starting Plaid…'
                : phase === 'importing'
                  ? 'Importing…'
                  : items.length === 0
                    ? 'Connect a bank'
                    : 'Connect another bank'}
            </button>
            {env === 'sandbox' && (
              <p className="small muted" style={{ marginTop: 8 }}>
                Sandbox login: user_good / pass_good (any 4-digit code if asked).
              </p>
            )}
            {phase === 'linking' && linkToken && (
              <p style={{ marginTop: 8 }}>
                <LinkButton token={linkToken} onLinked={(t) => void onLinked(t)} onCancelled={onCancelled} />
              </p>
            )}
            {phase === 'importing' && (
              <p className="small muted" style={{ marginTop: 8 }} role="status">
                Pulling accounts and transactions…
              </p>
            )}
          </div>

          {items.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 22 }}>
                Linked banks
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {items.map((item) => {
                  const active = job?.itemId === item.itemId ? job.kind : null;
                  return (
                    <div key={item.itemId} className="card spread" style={{ padding: '12px 14px', gap: 12, boxShadow: 'none' }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 650 }}>{item.institutionName}</span>
                          {item.needsReauth && <span className="badge badge-bad">Reconnect needed</span>}
                        </div>
                        <div className="small muted">
                          {plural(item.accountCount, 'account')} · {lastSyncLabel(item.lastSync)}
                        </div>
                      </div>
                      <div className="row" style={{ flex: 'none', gap: 8 }}>
                        {item.needsReauth ? (
                          <button className="btn" onClick={() => void startLink(item)} disabled={busy} style={{ whiteSpace: 'nowrap' }}>
                            {repairing?.itemId === item.itemId && phase !== 'idle' ? 'Reconnecting…' : 'Reconnect'}
                          </button>
                        ) : (
                          <button className="btn" onClick={() => void syncOne(item)} disabled={busy} style={{ whiteSpace: 'nowrap' }}>
                            {active === 'sync' ? 'Syncing…' : 'Sync'}
                          </button>
                        )}
                        <button
                          className="btn btn-ghost btn-danger"
                          onClick={() => void unlink(item)}
                          disabled={busy}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {active === 'unlink' ? 'Unlinking…' : 'Unlink'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {items.length === 0 && phase === 'idle' && (
            <p className="small muted" style={{ marginTop: 16, lineHeight: 1.6 }}>
              Linking pulls balances and up to two years of transactions, then categorizes them. Your credentials go
              straight to Plaid — Finch never sees them, and the access token stays on your machine.
            </p>
          )}

          <div className="spread" style={{ marginTop: 20, flexWrap: 'wrap', gap: 10 }}>
            <button className="btn btn-ghost" onClick={onImportCsv} style={{ whiteSpace: 'nowrap' }}>
              Import CSV instead
            </button>
            <button className="btn" onClick={onClose} disabled={busy} style={{ whiteSpace: 'nowrap' }}>
              Done
            </button>
          </div>
        </div>
      )}

    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div
      className="row"
      style={{ alignItems: 'flex-start', gap: 12, padding: '10px 12px', borderRadius: 'var(--r-md)', background: 'var(--surface-2)' }}
    >
      <span
        aria-hidden
        className="tnum"
        style={{
          flex: 'none',
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: 'var(--ink)',
          color: 'var(--surface)',
          fontSize: 11,
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 1,
        }}
      >
        {n}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="small" style={{ fontWeight: 650 }}>
          {title}
        </div>
        <div className="small" style={{ color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The page is open on a tunnel host, but the saved redirect URL isn't on it —
 * a combination that cannot work, since the bank sends the browser to whatever
 * Plaid was told. Offers the origin we're actually being served from.
 */
function UseThisOrigin({
  url,
  onUse,
  disabled,
}: {
  url: string;
  onUse: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span
          className="badge badge-warn"
          style={{ whiteSpace: 'normal', lineHeight: 1.55, padding: '5px 10px', minWidth: 0 }}
        >
          Use <span style={{ fontFamily: MONO, wordBreak: 'break-all' }}>{url}</span>
        </span>
        <button
          type="button"
          className="btn"
          onClick={onUse}
          disabled={disabled}
          style={{ flex: 'none', whiteSpace: 'nowrap' }}
        >
          Use this URL
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
        That&rsquo;s the address this tab is open on, so it&rsquo;s the one your bank can send you
        back to.
      </p>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', fontWeight: 600 }}>
      {children}
    </a>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.92em',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 5,
        padding: '1px 5px',
      }}
    >
      {children}
    </code>
  );
}

/** "Saved — client …0b673, secret …ccde1" (tails only; the values never reach the browser). */
function tailsLabel(tails: { clientIdTail: string; secretTail: string }): string {
  const parts: string[] = [];
  if (tails.clientIdTail) parts.push(`client …${tails.clientIdTail}`);
  if (tails.secretTail) parts.push(`secret …${tails.secretTail}`);
  return parts.length > 0 ? `Saved — ${parts.join(', ')}` : 'Saved';
}

function lastSyncLabel(iso?: string): string {
  if (!iso) return 'never synced';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never synced';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'synced just now';
  if (mins < 60) return `synced ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `synced ${days}d ago`;
  return `synced ${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
