import { useEffect, useRef, useState } from 'react';
import { loadPlaid, plaidScriptCount, type PlaidHandler } from '../../lib/plaidScript';

interface Props {
  /** A Link token from the backend. Mount this component only once you have one. */
  token: string;
  /** Fired with Link's public_token once the user finishes the bank flow. */
  onLinked: (publicToken: string) => void;
  /** Fired when Link closes without linking. `message` is set only when Plaid reported an error. */
  onCancelled: (message: string | null) => void;
  /**
   * OAuth resume only (the /oauth page): `window.location.href` as the bank
   * handed it back, `oauth_state_id` and all. Paired with the same `token`
   * the flow was opened with, Link picks the session back up where the
   * full-page redirect interrupted it. Leave unset everywhere else.
   */
  receivedRedirectUri?: string;
}

/**
 * Drives Plaid Link.
 *
 * This talks to `window.Plaid` directly rather than through react-plaid-link's
 * `usePlaidLink`, because that hook re-injects Plaid's SDK on every mount —
 * under StrictMode's double-mount and Vite hot swaps that produced two
 * controllers on one iframe and a Link modal that ignored every click. Here
 * the SDK loads once (see lib/plaidScript.ts) and each handler is explicitly
 * destroyed on unmount, so exactly one is ever live.
 */
export function LinkButton({ token, onLinked, onCancelled, receivedRedirectUri }: Props) {
  // Link fires exactly one terminal event; the ref keeps a re-render from replaying it.
  const done = useRef(false);
  // Callbacks live in refs so re-renders never tear down a live Link session.
  const onLinkedRef = useRef(onLinked);
  const onCancelledRef = useRef(onCancelled);
  onLinkedRef.current = onLinked;
  onCancelledRef.current = onCancelled;

  const [failure, setFailure] = useState<string | null>(null);
  const [duplicateSdk, setDuplicateSdk] = useState(false);

  useEffect(() => {
    let handler: PlaidHandler | null = null;
    let cancelled = false;
    done.current = false;

    void loadPlaid()
      .then((plaid) => {
        if (cancelled) return;

        // Two copies means an earlier load already poisoned the page; opening
        // now would give the user a frozen modal instead of an error.
        if (plaidScriptCount() > 1) {
          setDuplicateSdk(true);
          return;
        }

        handler = plaid.create({
          token,
          // Resuming an OAuth flow: same token, plus the URL the bank returned
          // to. Omitted entirely (not passed as undefined) in the normal case.
          ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
          // Link is a black-box iframe: when a step "does nothing" the only
          // way to see why is its event stream. OPEN_OAUTH without a
          // registered redirect URI, or an ERROR event, both look like a dead
          // button from the outside.
          onEvent: (eventName, metadata) => {
            const meta = (metadata ?? {}) as Record<string, unknown>;
            // eslint-disable-next-line no-console
            console.debug('[plaid-link]', eventName, {
              view: meta.view_name,
              institution: meta.institution_name,
              errorCode: meta.error_code,
              errorMessage: meta.error_message,
            });
            if (eventName === 'ERROR' && meta.error_message) {
              setFailure(String(meta.error_message));
            }
          },
          onSuccess: (publicToken) => {
            if (done.current) return;
            done.current = true;
            if (publicToken) onLinkedRef.current(publicToken);
            else onCancelledRef.current('Plaid closed without returning a token. Try again.');
          },
          onExit: (err) => {
            if (done.current) return;
            done.current = true;
            onCancelledRef.current(
              err
                ? err.display_message || err.error_message || 'Plaid Link closed with an error.'
                : null,
            );
          },
        });
        handler.open();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFailure(err instanceof Error ? err.message : 'Plaid Link could not be opened.');
      });

    return () => {
      cancelled = true;
      // StrictMode mounts this twice in dev; destroying here guarantees the
      // first handler is gone before the second opens.
      if (handler) {
        try {
          handler.exit({ force: true });
        } catch {
          /* Link may already be closed */
        }
        handler.destroy();
      }
    };
  }, [token, receivedRedirectUri]);

  if (duplicateSdk) {
    return (
      <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
        <span className="badge badge-warn">Refresh needed</span>
        <p className="small" style={{ color: 'var(--ink-2)', margin: 0 }}>
          A code reload left two copies of Plaid&rsquo;s SDK on this page, which makes Link open
          frozen. One refresh clears it — your keys are already saved, so you&rsquo;ll come straight
          back here.
        </p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Refresh and connect
        </button>
      </div>
    );
  }

  if (failure) {
    return (
      <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
        <span className="badge badge-bad">Couldn&rsquo;t open Plaid</span>
        <p className="small" style={{ color: 'var(--ink-2)', margin: 0 }}>
          {failure}
        </p>
      </div>
    );
  }

  return (
    <span className="small muted" role="status">
      Plaid Link is open — finish in the popup.
    </span>
  );
}
