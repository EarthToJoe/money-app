import { useCallback, useState, type ReactNode } from 'react';
import { useApp } from '../store';
import { finishLink } from '../lib/plaid';
import { clearPendingLink, readPendingLink, setJustLinked } from '../lib/oauthResume';
import { LinkButton } from './accounts/LinkButton';
import { errText, plural, runSync, summarizeSync } from './accounts/sync';

/**
 * The page a bank redirects back to after an OAuth sign-in.
 *
 * The URL registered with Plaid (Developers → API → Allowed redirect URIs) is
 * "https://<host>/oauth", so this is a real path, not a hash route — App.tsx
 * renders it INSTEAD of the app shell, because the user is mid-flow and the
 * only thing that matters is handing control back to Plaid Link.
 *
 * Link resumes when it is re-created with the same link_token the flow started
 * with (stashed in sessionStorage by whoever opened Link — see
 * lib/oauthResume.ts) plus `receivedRedirectUri: window.location.href`, which
 * carries the `oauth_state_id` the bank appended. Link then finishes the
 * account picker and fires onSuccess with a public_token, exactly as it would
 * have done if the page had never navigated away.
 */

type Phase =
  | { kind: 'resuming' }
  | { kind: 'importing' }
  | { kind: 'done'; heading: string; detail: string }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled'; message: string | null };

function goToAccounts(): void {
  // replace(), not assign(): the /oauth URL carries a spent oauth_state_id, so
  // it must not sit in history where Back would replay it.
  window.location.replace('/#/accounts');
}

export default function OAuthReturn() {
  const applySync = useApp((s) => s.applySync);

  // Read once, on the first render: this is a one-shot handoff, and re-reading
  // after clearPendingLink() would flip the page to the "nothing in progress"
  // state in the middle of the flow.
  const [pending] = useState(readPendingLink);
  const [phase, setPhase] = useState<Phase>({ kind: 'resuming' });

  const onLinked = useCallback(
    async (publicToken: string) => {
      setPhase({ kind: 'importing' });
      try {
        if (pending?.itemId) {
          // Update mode (a reconnect that went through OAuth). The stored
          // access token is still the right one — it just works again now — so
          // this public token must NOT be exchanged.
          const totals = await runSync(applySync, pending.itemId);
          clearPendingLink();
          setJustLinked('your bank');
          setPhase({ kind: 'done', heading: 'Reconnected', detail: summarizeSync(totals) });
        } else {
          const linked = await finishLink(publicToken, applySync, runSync);
          clearPendingLink();
          setJustLinked(linked.institutionName);
          setPhase({
            kind: 'done',
            heading: `Connected ${linked.institutionName}`,
            detail: `${plural(linked.accountCount, 'account')}, ${plural(linked.txnsAdded, 'transaction')} imported`,
          });
        }
        goToAccounts();
      } catch (e) {
        // The token is spent either way — don't leave it behind to be resumed.
        clearPendingLink();
        setPhase({
          kind: 'error',
          message: errText(e, 'Your bank signed you in, but importing its data failed.'),
        });
      }
    },
    [applySync, pending],
  );

  const onCancelled = useCallback((message: string | null) => {
    clearPendingLink();
    setPhase({ kind: 'cancelled', message });
  }, []);

  // --- No flow in progress --------------------------------------------------
  //
  // Someone opened /oauth directly, refreshed it after finishing, or came back
  // to a link token that has since expired (readPendingLink() drops those).
  if (!pending) {
    return (
      <Card title="Nothing to finish here">
        <p className="small" style={{ color: 'var(--ink-2)', lineHeight: 1.65 }}>
          This page is where your bank sends you back after signing in. There&rsquo;s no sign-in in
          progress — head back to Accounts.
        </p>
        <BackButton primary />
      </Card>
    );
  }

  if (phase.kind === 'cancelled') {
    return (
      <Card title="Sign-in didn’t finish">
        <span className="badge badge-bad" style={{ justifySelf: 'start' }}>
          Not connected
        </span>
        <p className="small" style={{ color: 'var(--ink-2)', lineHeight: 1.65 }}>
          {phase.message ??
            'Your bank’s sign-in closed before it finished, so nothing was connected. You can start again from Accounts.'}
        </p>
        <BackButton primary />
      </Card>
    );
  }

  if (phase.kind === 'error') {
    return (
      <Card title="Couldn’t finish importing">
        <span className="badge badge-bad" style={{ justifySelf: 'start' }}>
          Import failed
        </span>
        <p className="small" style={{ color: 'var(--critical)', lineHeight: 1.65 }}>
          {phase.message}
        </p>
        <p className="small muted" style={{ lineHeight: 1.65 }}>
          If the bank is listed under Connect bank, it did link — press Sync there to pull the
          transactions. If it isn&rsquo;t, connect it again.
        </p>
        <BackButton primary />
      </Card>
    );
  }

  if (phase.kind === 'done') {
    // goToAccounts() has already run; this is what shows in the moment before
    // the navigation lands — and the way out if it somehow doesn't.
    return (
      <Card title={phase.heading}>
        <span className="badge badge-good" style={{ justifySelf: 'start' }}>
          Done
        </span>
        <p className="small" style={{ color: 'var(--ink-2)', lineHeight: 1.65 }}>
          {phase.detail}. Taking you back to Accounts…
        </p>
        <BackButton />
      </Card>
    );
  }

  // --- Resuming / importing -------------------------------------------------

  return (
    <Card title="Finishing up with your bank…">
      <p className="small muted" role="status" style={{ lineHeight: 1.65 }}>
        {phase.kind === 'importing'
          ? 'Signed in. Pulling your accounts and transactions — this takes a few seconds.'
          : 'Picking your sign-in back up where your bank left off. Keep this tab open.'}
      </p>

      {/* Mounting LinkButton IS the resume: it re-creates Link with the stored
          token and this page's URL. Unmounted the moment Link is done, so its
          cleanup can destroy the handler. */}
      {phase.kind === 'resuming' && (
        <LinkButton
          token={pending.token}
          receivedRedirectUri={window.location.href}
          onLinked={(t) => void onLinked(t)}
          onCancelled={onCancelled}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function BackButton({ primary }: { primary?: boolean }) {
  return (
    <button
      className={primary ? 'btn btn-primary' : 'btn'}
      onClick={goToAccounts}
      style={{ justifySelf: 'start' }}
    >
      Back to Accounts
    </button>
  );
}

/** One centred card — no sidebar, because wandering off mid-flow loses the sign-in. */
function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="page" style={{ maxWidth: 520, paddingTop: 'min(14vh, 96px)' }}>
      <div className="row" style={{ gap: 8, marginBottom: 14 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 7,
            background: 'var(--ink)',
            color: 'var(--surface)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 9.5C2 5.9 4.9 3 8.5 3H14v2.2H8.5c-2.4 0-4.3 1.9-4.3 4.3V13H2V9.5z" />
            <circle cx="11.2" cy="9.8" r="2.6" />
          </svg>
        </span>
        <span style={{ fontWeight: 700, letterSpacing: '-0.01em' }}>Finch</span>
      </div>
      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <h1 className="card-title" style={{ fontSize: 'var(--fs-lg)' }}>
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}
