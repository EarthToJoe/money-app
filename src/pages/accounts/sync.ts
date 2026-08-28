import { plaidTransactionId, syncItem, toAccount, toTransaction } from '../../lib/plaid';
import type { useApp } from '../../store';

// Shared plumbing between the Accounts header "Sync" button and the per-item
// Sync buttons inside the Connect-bank modal: pull from the backend, map the
// wire DTOs into our domain types, and hand them to the store in one upsert.

type ApplySync = ReturnType<typeof useApp.getState>['applySync'];

/** One item the backend couldn't sync. The rest of the batch still went through. */
export interface SyncFailure {
  itemId: string;
  message: string;
  needsReauth: boolean;
}

export interface SyncTotals {
  /** Number of Plaid items that reported back, successfully or not. */
  items: number;
  accountsAdded: number;
  accountsUpdated: number;
  txnsAdded: number;
  txnsUpdated: number;
  txnsRemoved: number;
  /** Items that came back with an error. Empty on a clean run. */
  failures: SyncFailure[];
}

const EMPTY: SyncTotals = {
  items: 0,
  accountsAdded: 0,
  accountsUpdated: 0,
  txnsAdded: 0,
  txnsUpdated: 0,
  txnsRemoved: 0,
  failures: [],
};

/**
 * Sync one item, or every linked item when itemId is omitted.
 * Throws whatever the backend call throws — callers surface the message.
 */
export async function runSync(applySync: ApplySync, itemId?: string): Promise<SyncTotals> {
  const results = await syncItem(itemId);
  const totals: SyncTotals = { ...EMPTY, failures: [] };

  for (const result of results) {
    // A failed item reports in-band with empty arrays — record why, then let the
    // upsert run anyway so a partially-successful batch still lands.
    if (result.error) {
      totals.failures.push({
        itemId: result.itemId,
        message: result.error.message,
        needsReauth: result.needsReauth === true,
      });
    }

    const stats = applySync({
      accounts: (result.accounts ?? []).map(toAccount),
      added: (result.added ?? []).map(toTransaction),
      modified: (result.modified ?? []).map(toTransaction),
      removedIds: (result.removed ?? []).map(plaidTransactionId),
    });
    totals.items += 1;
    totals.accountsAdded += stats.accountsAdded;
    totals.accountsUpdated += stats.accountsUpdated;
    totals.txnsAdded += stats.txnsAdded;
    totals.txnsUpdated += stats.txnsUpdated;
    totals.txnsRemoved += stats.txnsRemoved;
  }

  return totals;
}

/** "Synced 3 accounts · 12 new, 4 updated" */
export function summarizeSync(t: SyncTotals): string {
  if (t.items === 0) return 'Nothing to sync yet';

  // Every item failed: report the reason, not a misleading "up to date".
  if (t.failures.length === t.items) return failureText(t.failures);

  const accounts = t.accountsAdded + t.accountsUpdated;
  const changes: string[] = [];
  if (t.txnsAdded > 0) changes.push(`${t.txnsAdded.toLocaleString('en-US')} new`);
  if (t.txnsUpdated > 0) changes.push(`${t.txnsUpdated.toLocaleString('en-US')} updated`);
  if (t.txnsRemoved > 0) changes.push(`${t.txnsRemoved.toLocaleString('en-US')} removed`);

  const main =
    changes.length === 0
      ? accounts > 0
        ? `Already up to date · ${plural(accounts, 'balance')} refreshed`
        : 'Already up to date'
      : `Synced ${plural(accounts, 'account')} · ${changes.join(', ')}`;

  return t.failures.length > 0 ? `${main} · ${failureText(t.failures)}` : main;
}

/** "Chase needs reconnecting" / "1 bank failed: <reason>" */
function failureText(failures: SyncFailure[]): string {
  const reauth = failures.filter((f) => f.needsReauth).length;
  if (reauth === failures.length) {
    return `${plural(reauth, 'bank')} ${reauth === 1 ? 'needs' : 'need'} reconnecting — open Connect bank and hit Reconnect`;
  }
  if (failures.length === 1) return `1 bank failed: ${failures[0].message}`;
  return `${plural(failures.length, 'bank')} failed to sync`;
}

/** "1 account" / "12 accounts" */
export function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** Message text out of an unknown throw. */
export function errText(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e.trim()) return e;
  return fallback;
}
