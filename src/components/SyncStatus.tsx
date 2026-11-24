import { dismissSyncNotice, signOut, useSyncStatus } from '../lib/cloudSync';

const LABEL = {
  checking: 'Connecting…',
  syncing: 'Syncing…',
  synced: 'Synced',
  offline: 'Offline: saved on this device',
  'signed-out': 'Signed out',
  off: '',
} as const;

/** A small line in the sidebar saying whether this device's data is synced. */
export default function SyncStatus() {
  const { phase, notice } = useSyncStatus();
  if (phase === 'off') return null;

  return (
    <div className="sync-status" data-phase={phase}>
      <span className="sync-dot" aria-hidden="true" />
      <span className="sync-label">{LABEL[phase]}</span>
      {phase === 'synced' && (
        <button className="sync-signout" onClick={() => void signOut()}>
          Sign out
        </button>
      )}
      {notice && (
        <div className="sync-notice" role="status">
          {notice}{' '}
          <button className="sync-signout" onClick={dismissSyncNotice}>
            OK
          </button>
        </div>
      )}
    </div>
  );
}
