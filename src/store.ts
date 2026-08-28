import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Account,
  BonusTracking,
  Budget,
  CategoryId,
  CreditUsage,
  PointsBalance,
  Settings,
  Transaction,
} from './types';
import { generateDemoData } from './data/demoSeed';

/** Bump when the demo dataset gains fields; existing demo users get regenerated data (budgets kept). */
export const DEMO_VERSION = 3;

function dedupeKey(t: Transaction): string {
  return [t.accountId, t.date, t.amount.toFixed(2), t.rawDescription.trim().toLowerCase()].join('|');
}

interface AppState {
  accounts: Account[];
  transactions: Transaction[];
  budgets: Budget[];
  pointsBalances: PointsBalance[];
  creditUsages: CreditUsage[];
  settings: Settings;
  /** Ids of transactions the user recategorized by hand — a sync must not overwrite these. */
  manualCategoryIds: string[];
  demoLoaded: boolean;
  demoVersion: number;
  /** Set once the user clears data, so demo accounts never reappear on their own. */
  demoCleared: boolean;

  loadDemoData: () => void;
  resetAll: () => void;
  addAccount: (account: Account) => void;
  updateAccount: (accountId: string, patch: Partial<Account>) => void;
  removeAccount: (accountId: string) => void;
  /** Adds transactions, skipping duplicates (same account, date, amount, description). Returns count actually added. */
  addTransactions: (txns: Transaction[]) => number;
  setTransactionCategory: (txnId: string, category: CategoryId) => void;
  setBudget: (categoryId: CategoryId, monthlyLimit: number) => void;
  removeBudget: (categoryId: CategoryId) => void;

  /** Set or update the bonus tracking on a card; pass undefined to stop tracking. */
  setAccountBonus: (accountId: string, bonus: BonusTracking | undefined) => void;
  /** Upsert a loyalty balance (stamps updatedAt with today). */
  setPointsBalance: (programId: string, balance: number, note?: string) => void;
  removePointsBalance: (programId: string) => void;
  /** Record how much of a credit was used in a period (0 clears the record). */
  setCreditUsage: (accountId: string, creditId: string, periodKey: string, used: number) => void;
  updateSettings: (patch: Partial<Settings>) => void;

  /**
   * Apply a Plaid sync. Accounts and transactions are keyed by their stable
   * Plaid-derived ids, so re-syncing updates rows instead of duplicating them.
   * A user's manual category override on a transaction is preserved.
   * Returns what changed.
   */
  applySync: (input: {
    accounts: Account[];
    added: Transaction[];
    modified?: Transaction[];
    removedIds?: string[];
    /**
     * Set only when the sync covered EVERY linked bank. Local Plaid accounts
     * missing from `accounts` then belonged to an item that no longer exists
     * server-side — e.g. sandbox banks that were unlinked — and are removed
     * along with their transactions. Never set this for a single-item sync, or
     * it would delete every other bank's accounts.
     */
    pruneOrphans?: boolean;
  }) => { accountsAdded: number; accountsUpdated: number; txnsAdded: number; txnsUpdated: number; txnsRemoved: number };
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      accounts: [],
      transactions: [],
      budgets: [],
      pointsBalances: [],
      creditUsages: [],
      settings: {},
      manualCategoryIds: [],
      demoLoaded: false,
      demoVersion: 0,
      demoCleared: false,

      loadDemoData: () => {
        const { accounts, transactions, pointsBalances, creditUsages } = generateDemoData();
        set({
          accounts,
          transactions,
          pointsBalances,
          creditUsages,
          demoLoaded: true,
          demoVersion: DEMO_VERSION,
          demoCleared: false,
        });
      },

      resetAll: () =>
        set({
          accounts: [],
          transactions: [],
          budgets: [],
          pointsBalances: [],
          creditUsages: [],
          manualCategoryIds: [],
          demoLoaded: false,
          demoVersion: 0,
          // Without this the startup effect would see an empty app and helpfully
          // put the demo accounts straight back — making "reset" look broken.
          demoCleared: true,
        }),

      addAccount: (account) => set((s) => ({ accounts: [...s.accounts, account] })),

      updateAccount: (accountId, patch) =>
        set((s) => ({
          accounts: s.accounts.map((a) => (a.id === accountId ? { ...a, ...patch } : a)),
        })),

      removeAccount: (accountId) =>
        set((s) => ({
          accounts: s.accounts.filter((a) => a.id !== accountId),
          transactions: s.transactions.filter((t) => t.accountId !== accountId),
          creditUsages: s.creditUsages.filter((u) => u.accountId !== accountId),
        })),

      addTransactions: (txns) => {
        const existing = new Set(get().transactions.map(dedupeKey));
        const fresh = txns.filter((t) => {
          const key = dedupeKey(t);
          if (existing.has(key)) return false;
          existing.add(key);
          return true;
        });
        if (fresh.length > 0) {
          set((s) => ({
            transactions: [...s.transactions, ...fresh].sort((a, b) =>
              b.date.localeCompare(a.date),
            ),
          }));
        }
        return fresh.length;
      },

      setTransactionCategory: (txnId, category) =>
        set((s) => ({
          transactions: s.transactions.map((t) => (t.id === txnId ? { ...t, category } : t)),
          manualCategoryIds: s.manualCategoryIds.includes(txnId)
            ? s.manualCategoryIds
            : [...s.manualCategoryIds, txnId],
        })),

      setBudget: (categoryId, monthlyLimit) =>
        set((s) => ({
          budgets: [
            ...s.budgets.filter((b) => b.categoryId !== categoryId),
            { categoryId, monthlyLimit },
          ],
        })),

      removeBudget: (categoryId) =>
        set((s) => ({ budgets: s.budgets.filter((b) => b.categoryId !== categoryId) })),

      setAccountBonus: (accountId, bonus) =>
        set((s) => ({
          accounts: s.accounts.map((a) => {
            if (a.id !== accountId) return a;
            if (!bonus) {
              const { bonus: _drop, ...rest } = a;
              return rest;
            }
            return { ...a, bonus };
          }),
        })),

      setPointsBalance: (programId, balance, note) =>
        set((s) => ({
          pointsBalances: [
            ...s.pointsBalances.filter((b) => b.programId !== programId),
            { programId, balance, updatedAt: todayIso(), ...(note !== undefined ? { note } : {}) },
          ],
        })),

      removePointsBalance: (programId) =>
        set((s) => ({ pointsBalances: s.pointsBalances.filter((b) => b.programId !== programId) })),

      setCreditUsage: (accountId, creditId, periodKey, used) =>
        set((s) => {
          const rest = s.creditUsages.filter(
            (u) => !(u.accountId === accountId && u.creditId === creditId && u.periodKey === periodKey),
          );
          return { creditUsages: used > 0 ? [...rest, { accountId, creditId, periodKey, used }] : rest };
        }),

      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      applySync: ({ accounts, added, modified = [], removedIds = [], pruneOrphans = false }) => {
        let state = get();
        const stats = { accountsAdded: 0, accountsUpdated: 0, txnsAdded: 0, txnsUpdated: 0, txnsRemoved: 0 };

        // Real accounts have arrived, so the demo wallet goes — otherwise the
        // sample Amex Gold and its fake welcome bonus sit alongside the user's
        // actual cards and every total is wrong. Demo accounts are exactly the
        // ones referenced by demo transactions; CSV and Plaid accounts are not.
        // Deliberately NOT gated on demoLoaded: if that flag was ever cleared
        // while demo accounts survived (a partial reset, an older build), the
        // sample cards would sit next to the real ones forever. Presence of
        // demo-sourced transactions is the reliable signal.
        const hasDemoData =
          state.demoLoaded || state.transactions.some((t) => t.source === 'demo');
        if (hasDemoData && accounts.length > 0) {
          const demoAccountIds = new Set(
            state.transactions.filter((t) => t.source === 'demo').map((t) => t.accountId),
          );
          const incomingIds = new Set(accounts.map((a) => a.id));
          set({
            accounts: state.accounts.filter((a) => !demoAccountIds.has(a.id) || incomingIds.has(a.id)),
            transactions: state.transactions.filter((t) => t.source !== 'demo'),
            // Demo points balances and credit usages are fabricated too.
            pointsBalances: [],
            creditUsages: [],
            demoLoaded: false,
            demoCleared: true,
          });
          state = get();
        }

        // Drop Plaid accounts whose bank is no longer linked. Sandbox items
        // unlinked server-side otherwise linger here forever — they are tagged
        // as real Plaid data, so the demo purge above never touches them.
        if (pruneOrphans && accounts.length > 0) {
          const live = new Set(accounts.map((a) => a.id));
          const stale = new Set(
            state.accounts
              .filter((a) => String(a.id).startsWith('plaid:') && !live.has(a.id))
              .map((a) => a.id),
          );
          if (stale.size > 0) {
            set({
              accounts: state.accounts.filter((a) => !stale.has(a.id)),
              transactions: state.transactions.filter((t) => !stale.has(t.accountId)),
              creditUsages: state.creditUsages.filter((u) => !stale.has(u.accountId)),
            });
            state = get();
          }
        }

        // Accounts: upsert by id, preserving fields the user set here
        // (openedAt, bonus tracking, and a manually linked card product).
        const byId = new Map(state.accounts.map((a) => [a.id, a]));
        for (const incoming of accounts) {
          const existing = byId.get(incoming.id);
          if (existing) {
            byId.set(incoming.id, {
              ...incoming,
              openedAt: existing.openedAt ?? incoming.openedAt,
              productId: existing.productId ?? incoming.productId,
              ...(existing.bonus ? { bonus: existing.bonus } : {}),
            });
            stats.accountsUpdated++;
          } else {
            byId.set(incoming.id, incoming);
            stats.accountsAdded++;
          }
        }

        // Transactions: upsert by id, keeping a user's category override.
        const txById = new Map(state.transactions.map((t) => [t.id, t]));
        const manual = new Set(state.manualCategoryIds);
        for (const t of [...added, ...modified]) {
          const existing = txById.get(t.id);
          if (existing) {
            txById.set(t.id, manual.has(t.id) ? { ...t, category: existing.category } : t);
            stats.txnsUpdated++;
          } else {
            txById.set(t.id, t);
            stats.txnsAdded++;
          }
        }
        for (const id of removedIds) {
          if (txById.delete(id)) stats.txnsRemoved++;
        }

        set({
          accounts: [...byId.values()],
          transactions: [...txById.values()].sort((a, b) => b.date.localeCompare(a.date)),
        });
        return stats;
      },
    }),
    {
      name: 'finch-v1',
      partialize: (s) => ({
        accounts: s.accounts,
        transactions: s.transactions,
        budgets: s.budgets,
        pointsBalances: s.pointsBalances,
        creditUsages: s.creditUsages,
        settings: s.settings,
        manualCategoryIds: s.manualCategoryIds,
        demoLoaded: s.demoLoaded,
        demoVersion: s.demoVersion,
        demoCleared: s.demoCleared,
      }),
    },
  ),
);
