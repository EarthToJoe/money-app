import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { CATEGORIES, categoryDef } from '../data/categories';
import { currentMonthKey, isSpending, monthKeyOf, monthLabel } from '../lib/analytics';
import { fmtDateShort, fmtNum, fmtUsd } from '../lib/format';
import type { Account, CategoryId, Transaction } from '../types';

const PAGE_SIZE = 120;

type MonthFilter = string; // 'all' or a 'YYYY-MM' key
type AccountFilter = string; // 'all' or an account id
type CategoryFilter = 'all' | CategoryId;

function CategoryCell({ txn }: { txn: Transaction }) {
  const setTransactionCategory = useApp((s) => s.setTransactionCategory);
  const def = categoryDef(txn.category);
  return (
    <div className="row" style={{ gap: 7 }}>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: def.color,
          flex: 'none',
        }}
      />
      <select
        className="select"
        aria-label={`Category for ${txn.merchant}`}
        value={txn.category}
        onChange={(e) => setTransactionCategory(txn.id, e.target.value as CategoryId)}
        style={{ padding: '3px 8px', fontSize: 'var(--fs-xs)', fontWeight: 600 }}
      >
        {CATEGORIES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.emoji} {c.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function AmountCell({ amount }: { amount: number }) {
  if (amount < 0) {
    return <span style={{ color: 'var(--good-text)', fontWeight: 600 }}>+{fmtUsd(-amount)}</span>;
  }
  return <span>{fmtUsd(amount)}</span>;
}

export default function Transactions() {
  const transactions = useApp((s) => s.transactions);
  const accounts = useApp((s) => s.accounts);

  const [month, setMonth] = useState<MonthFilter>(() => currentMonthKey());
  const [account, setAccount] = useState<AccountFilter>('all');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  // Debounce the search box (~200ms) so filtering doesn't run on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput), 200);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // New filter → back to the first page of rows.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [month, account, category, search]);

  const months = useMemo(() => {
    const keys = new Set<string>();
    for (const t of transactions) keys.add(monthKeyOf(t.date));
    return [...keys].sort((a, b) => b.localeCompare(a)); // newest first
  }, [transactions]);

  const accountById = useMemo(() => {
    const map = new Map<string, Account>();
    for (const a of accounts) map.set(a.id, a);
    return map;
  }, [accounts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions
      .filter((t) => {
        if (month !== 'all' && monthKeyOf(t.date) !== month) return false;
        if (account !== 'all' && t.accountId !== account) return false;
        if (category !== 'all' && t.category !== category) return false;
        if (
          q &&
          !t.merchant.toLowerCase().includes(q) &&
          !t.rawDescription.toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date)); // newest first
  }, [transactions, month, account, category, search]);

  // Spent / Income / Net exclude transfers, so a card payment (money out of
  // checking, money into the card) doesn't double-count against the purchases.
  const totals = useMemo(() => {
    let spend = 0;
    let income = 0;
    let transfers = 0;
    for (const t of filtered) {
      if (t.category === 'transfer') transfers += 1;
      else if (t.category === 'income') income += -t.amount;
      else if (isSpending(t)) spend += t.amount;
    }
    return { spend, income, net: income - spend, transfers };
  }, [filtered]);

  const visible = filtered.slice(0, limit);
  const hasAnyData = transactions.length > 0;
  const filtersActive =
    month !== 'all' || account !== 'all' || category !== 'all' || search.trim() !== '';

  const clearFilters = () => {
    setMonth('all');
    setAccount('all');
    setCategory('all');
    setSearchInput('');
    setSearch('');
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Transactions</h1>
          <p className="page-subtitle">
            {fmtNum(filtered.length)} transaction{filtered.length === 1 ? '' : 's'} ·{' '}
            {fmtUsd(totals.spend)} spent
          </p>
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 16 }}>
        <select
          className="select"
          aria-label="Filter by month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        >
          <option value="all">All time</option>
          {month !== 'all' && !months.includes(month) && (
            <option value={month}>{monthLabel(month)}</option>
          )}
          {months.map((key) => (
            <option key={key} value={key}>
              {monthLabel(key)}
            </option>
          ))}
        </select>

        <select
          className="select"
          aria-label="Filter by account"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="all">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <select
          className="select"
          aria-label="Filter by category"
          value={category}
          onChange={(e) => setCategory(e.target.value as CategoryFilter)}
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>

        <input
          className="input"
          type="search"
          placeholder="Search merchant or description…"
          aria-label="Search transactions"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{ flex: '1 1 220px' }}
        />
      </div>

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="stat">
            <span className="stat-label">Spent</span>
            <span className="stat-value sm tnum">{fmtUsd(totals.spend)}</span>
            <span className="stat-delta muted small">purchases, net of refunds</span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="stat-label">Income</span>
            <span className="stat-value sm tnum">{fmtUsd(totals.income)}</span>
            <span className="stat-delta muted small">paychecks, interest, deposits</span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="stat-label">Net</span>
            <span
              className="stat-value sm tnum"
              style={totals.net > 0 ? { color: 'var(--good-text)' } : undefined}
            >
              {totals.net > 0 ? '+' : ''}
              {fmtUsd(totals.net)}
            </span>
            <span className="stat-delta muted small">
              income − spent{totals.transfers > 0 ? ` · ${totals.transfers} transfers excluded` : ''}
            </span>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="big">{hasAnyData ? '🔍' : '🧾'}</div>
            {hasAnyData ? (
              <>
                <p>No transactions match your filters.</p>
                {filtersActive && (
                  <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={clearFilters}>
                    Clear filters
                  </button>
                )}
              </>
            ) : (
              <>
                <p>No transactions yet.</p>
                <p className="muted small" style={{ marginTop: 4 }}>
                  Load the demo data or import a CSV to get started.
                </p>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: '6px 14px 14px' }}>
          <div style={{ overflowX: 'auto' }}>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Merchant</th>
                    <th>Account</th>
                    <th>Category</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t) => {
                    const acct = accountById.get(t.accountId);
                    return (
                      <tr key={t.id}>
                        <td className="tnum" style={{ whiteSpace: 'nowrap' }}>
                          {fmtDateShort(t.date)}
                        </td>
                        <td>
                          <div className="row" style={{ gap: 8 }}>
                            <span style={{ fontWeight: 650 }}>{t.merchant}</span>
                            {t.pending && <span className="badge badge-neutral">Pending</span>}
                          </div>
                          <div className="muted small" style={{ fontSize: 'var(--fs-xs)' }}>
                            {t.rawDescription}
                          </div>
                        </td>
                        <td className="small muted" style={{ whiteSpace: 'nowrap' }}>
                          {acct ? (
                            <>
                              {acct.name} <span className="tnum">••{acct.mask}</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          <CategoryCell txn={t} />
                        </td>
                        <td className="num tnum" style={{ whiteSpace: 'nowrap' }}>
                          <AmountCell amount={t.amount} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          {filtered.length > limit && (
            <div className="spread" style={{ marginTop: 12, padding: '0 10px' }}>
              <span className="muted small">
                Showing {fmtNum(visible.length)} of {fmtNum(filtered.length)}
              </span>
              <button className="btn" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                Show more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
