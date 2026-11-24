import { useEffect, useState } from 'react';
import { DEMO_VERSION, useApp } from './store';
import { isOAuthReturn } from './lib/oauthResume';
import { startCloudSync, useSyncStatus } from './lib/cloudSync';
import SyncStatus from './components/SyncStatus';
import SignIn from './pages/SignIn';
import OAuthReturn from './pages/OAuthReturn';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import Budgets from './pages/Budgets';
import Rewards from './pages/Rewards';
import Accounts from './pages/Accounts';
import Wallet from './pages/Wallet';
import Points from './pages/Points';
import Advisor from './pages/Advisor';

type PageId = 'dashboard' | 'advisor' | 'wallet' | 'points' | 'rewards' | 'transactions' | 'budgets' | 'accounts';

const NAV: Array<{ id: PageId; label: string; icon: JSX.Element }> = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: (
      <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="2.5" y="2.5" width="6.2" height="6.2" rx="1.5" />
        <rect x="11.3" y="2.5" width="6.2" height="6.2" rx="1.5" />
        <rect x="2.5" y="11.3" width="6.2" height="6.2" rx="1.5" />
        <rect x="11.3" y="11.3" width="6.2" height="6.2" rx="1.5" />
      </svg>
    ),
  },
  {
    id: 'advisor',
    label: 'Advisor',
    icon: (
      <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="9" cy="9" r="5.5" />
        <path d="M13.2 13.2L17 17" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'wallet',
    label: 'Wallet',
    icon: (
      <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M3 6.5a2 2 0 012-2h9.5a1 1 0 011 1V6H5a1.5 1.5 0 000 3h11.5a.5.5 0 01.5.5v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-8z" strokeLinejoin="round" />
        <circle cx="13.5" cy="12.2" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: 'points',
    label: 'Points',
    icon: (
      <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M10 2.8l2.1 4.4 4.8.6-3.5 3.3.9 4.8L10 13.6l-4.3 2.3.9-4.8L3.1 7.8l4.8-.6L10 2.8z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'transactions',
    label: 'Transactions',
    icon: (
      <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M3 5.5h14M3 10h14M3 14.5h9" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'budgets',
    label: 'Budgets',
    icon: (
      <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="10" cy="10" r="7.2" />
        <path d="M10 10V3.2M10 10l5 4.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'rewards',
    label: 'Rewards',
    icon: (
      <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
        <path d="M2.5 8.5h15" />
      </svg>
    ),
  },
  {
    id: 'accounts',
    label: 'Accounts',
    icon: (
      <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M3 8l7-4.5L17 8M4.5 8v7M15.5 8v7M8 15V8m4 7V8M3 15.5h14" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

function useHashRoute(): [PageId, (p: PageId) => void] {
  const read = (): PageId => {
    const h = window.location.hash.replace('#/', '').replace('#', '');
    return (NAV.some((n) => n.id === h) ? h : 'dashboard') as PageId;
  };
  const [page, setPage] = useState<PageId>(read);
  useEffect(() => {
    const onHash = () => setPage(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (p: PageId) => {
    window.location.hash = `/${p}`;
  };
  return [page, go];
}

/**
 * /oauth is a real path, not a hash route: it is the exact string registered
 * with Plaid as an allowed redirect URI, and a bank redirecting the browser
 * back drops everything after '#'. It renders on its own — no sidebar, no
 * hash routing — because the user is in the middle of a bank sign-in and the
 * page's whole job is to hand control back to Plaid Link.
 *
 * Deciding here, in a component that calls no hooks of its own, keeps the
 * shell's hooks (and its demo-data effect) untouched on every other path.
 */
export default function App() {
  if (isOAuthReturn()) return <OAuthReturn />;
  return <SyncedApp />;
}

/**
 * Starts syncing with the server, and swaps in the sign-in screen when the
 * server needs a password this device hasn't given yet.
 */
function SyncedApp() {
  const phase = useSyncStatus((s) => s.phase);
  useEffect(() => {
    void startCloudSync();
  }, []);
  if (phase === 'signed-out') return <SignIn />;
  return <AppShell />;
}

function AppShell() {
  const [page, go] = useHashRoute();
  const accounts = useApp((s) => s.accounts);
  const demoLoaded = useApp((s) => s.demoLoaded);
  const loadDemoData = useApp((s) => s.loadDemoData);

  const demoVersion = useApp((s) => s.demoVersion);
  const demoCleared = useApp((s) => s.demoCleared);

  // First run: populate with demo data so every page is instantly explorable.
  // Existing demo users get regenerated data when the dataset gains fields
  // (budgets, balances you typed, and settings are kept).
  useEffect(() => {
    if (demoCleared) return; // user asked for an empty app — respect it
    if (accounts.length === 0 && !demoLoaded) loadDemoData();
    else if (demoLoaded && demoVersion < DEMO_VERSION) loadDemoData();
  }, [accounts.length, demoLoaded, demoVersion, demoCleared, loadDemoData]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 9.5C2 5.9 4.9 3 8.5 3H14v2.2H8.5c-2.4 0-4.3 1.9-4.3 4.3V13H2V9.5z" />
              <circle cx="11.2" cy="9.8" r="2.6" />
            </svg>
          </div>
          Finch
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-item${page === n.id ? ' active' : ''}`}
            onClick={() => go(n.id)}
          >
            {n.icon}
            {n.label}
          </button>
        ))}
        <SyncStatus />
        <div className="sidebar-footer">
          Finch shows math on reward rates, not financial advice. Verify card terms with the
          issuer before applying.
        </div>
      </aside>
      <main className="content">
        {page === 'dashboard' && <Dashboard />}
        {page === 'transactions' && <Transactions />}
        {page === 'budgets' && <Budgets />}
        {page === 'rewards' && <Rewards />}
        {page === 'accounts' && <Accounts />}
        {page === 'wallet' && <Wallet />}
        {page === 'points' && <Points />}
        {page === 'advisor' && <Advisor />}
      </main>
    </div>
  );
}
