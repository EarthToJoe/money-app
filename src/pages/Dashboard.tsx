import { useMemo, type CSSProperties } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useApp } from '../store';
import {
  addMonths,
  budgetProgress,
  currentMonthKey,
  monthKeyOf,
  monthLabel,
  monthLabelShort,
  monthlySpendingSeries,
  spendingByCategory,
  topMerchants,
  totalIncome,
  totalSpending,
  type CategoryTotal,
  type MonthPoint,
} from '../lib/analytics';
import { fmtCents, fmtDateShort, fmtPct, fmtUsd, fmtUsdCompact, fmtUsdWhole } from '../lib/format';
import { computeEarnings, computeMissed } from '../lib/rewards';
import { bonusProgressAll, type BonusProgress } from '../lib/bonus';
import { creditsAll, type CreditStatus } from '../lib/credits';
import { totalValueCents } from '../lib/loyalty';
import { categoryDef } from '../data/categories';
import { CategoryChip } from '../components/CategoryChip';
import type { Transaction } from '../types';

// Chart palette (hex mirrors of src/styles/tokens.css — recharts SVG attrs
// don't resolve CSS vars reliably across renderers).
const SERIES_1 = '#2a78d6'; // --series-1, current month
const SERIES_1_LIGHT = '#9ec5f4'; // lighter step of the same hue, prior months
const OTHER_COLOR = '#b7b5ad';
const INK = '#0b0b0b';
const INK_3 = '#898781';

const AXIS_TICK = { fontSize: 11.5, fill: INK_3 } as const;

const TOOLTIP_STYLE: CSSProperties = {
  background: '#fcfcfb',
  border: '1px solid rgba(11, 11, 11, 0.1)',
  borderRadius: 12,
  boxShadow: 'var(--shadow-md)',
  padding: '8px 12px',
};

/** '2026-07' → 'July' */
function monthNameLong(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long' });
}

function go(hash: string) {
  window.location.hash = hash;
}

// ---------------------------------------------------------------------------
// Spending bar chart (12 months)

function SpendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: MonthPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div style={TOOLTIP_STYLE}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: INK_3 }}>{monthLabel(p.month)}</div>
      <div className="tnum" style={{ fontSize: 13, fontWeight: 650, color: INK }}>
        {fmtUsd(p.total)}
      </div>
    </div>
  );
}

function SpendingChart({ series, monthKey }: { series: MonthPoint[]; monthKey: string }) {
  const hasData = series.some((p) => p.total > 0);
  if (!hasData) {
    return (
      <div className="empty-state">
        <div className="big">📊</div>
        <p>No spending to chart yet — add transactions in Accounts.</p>
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={230}>
      <BarChart data={series} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis
          dataKey="month"
          tickFormatter={monthLabelShort}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: 'var(--baseline)' }}
          interval={0}
        />
        <YAxis
          tickFormatter={fmtUsdCompact}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip content={<SpendTooltip />} cursor={{ fill: 'rgba(11, 11, 11, 0.04)' }} />
        <Bar dataKey="total" barSize={18} radius={[4, 4, 0, 0]}>
          {series.map((p) => (
            <Cell key={p.month} fill={p.month === monthKey ? SERIES_1 : SERIES_1_LIGHT} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// "Where it went" — plain-div horizontal category bars

export interface CatRow {
  key: string;
  label: string;
  color: string;
  total: number;
}

/** How many real categories get their own row before the rest are folded. */
const TOP_CATEGORIES = 6;
/** Label for the fold row, and the label it falls back to on a collision. */
const FOLD_LABEL = 'Other';
const FOLD_LABEL_ALT = 'Everything else';

/**
 * Top categories get their own row; everything below them is summed into one
 * fold row.
 *
 * Label collision to keep in mind: there is a real CategoryId called 'other'
 * (labelled "Other") AND the synthetic fold row wants to be called "Other"
 * too. Folding the tail already absorbs a tail-resident 'other' into the sum,
 * so the danger is only the other way round — 'other' big enough to land in the
 * top N while a fold row also exists. That shipped once as two rows both
 * reading "Other" ($869.66 and $442.27) with nothing to tell them apart. The
 * fold therefore checks the labels already on screen and renames itself to
 * "Everything else" when "Other" is taken. Never render two rows with the same
 * label.
 */
export function foldCategoryRows(cats: CategoryTotal[]): CatRow[] {
  const rows: CatRow[] = cats.slice(0, TOP_CATEGORIES).map((c) => {
    const def = categoryDef(c.category);
    return { key: c.category, label: def.label, color: def.color, total: c.total };
  });
  // This sum already includes the real 'other' category when it sits down in
  // the tail — merged into the fold, never listed beside it.
  const foldedTotal = cats.slice(TOP_CATEGORIES).reduce((s, c) => s + c.total, 0);
  if (foldedTotal > 0) {
    const taken = rows.some((r) => r.label.toLowerCase() === FOLD_LABEL.toLowerCase());
    rows.push({
      key: '__folded',
      label: taken ? FOLD_LABEL_ALT : FOLD_LABEL,
      color: OTHER_COLOR,
      total: foldedTotal,
    });
  }
  return rows;
}

function CategoryBars({ rows }: { rows: CatRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <div className="big">🧺</div>
        <p>No spending yet this month.</p>
      </div>
    );
  }
  const max = Math.max(...rows.map((r) => r.total));
  return (
    <div style={{ display: 'grid', gap: 12, paddingTop: 4 }}>
      {rows.map((r) => (
        <div
          key={r.key}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 118px) 1fr 78px',
            gap: 10,
            alignItems: 'center',
          }}
        >
          <div className="row" style={{ gap: 7, minWidth: 0 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: r.color,
                flex: 'none',
              }}
            />
            <span
              className="small"
              style={{
                color: 'var(--ink-2)',
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.label}
            </span>
          </div>
          <div>
            <div
              style={{
                height: 8,
                borderRadius: 999,
                background: r.color,
                width: `${Math.max((r.total / max) * 100, 1.5)}%`,
              }}
            />
          </div>
          <span className="small tnum" style={{ textAlign: 'right', color: 'var(--ink)' }}>
            {fmtUsd(r.total)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wallet — the one thing to do next with each card: finish a welcome bonus,
// spend a credit before it resets, and what the points pile is worth.

function HashLink({ to, children }: { to: string; children: string }) {
  return (
    <a
      href={`#${to}`}
      className="small"
      style={{ color: 'var(--accent-strong)', fontWeight: 600 }}
      onClick={(e) => {
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

function daysLeftText(days: number): string {
  if (days <= 0) return 'due today';
  if (days === 1) return '1 day left';
  return `${days} days left`;
}

function resetsText(days: number): string {
  if (days <= 0) return 'resets today';
  if (days === 1) return 'resets tomorrow';
  return `resets in ${days} days`;
}

/** Whole dollars when it is a round amount ("$10"), cents when it isn't ("$3.42"). */
function creditAmount(n: number): string {
  return Number.isInteger(n) ? fmtUsdWhole(n) : fmtUsd(n);
}

interface WalletCardProps {
  /** The welcome bonus most worth finishing, if any. */
  bonus: BonusProgress | null;
  /** Credits with money left on them, resetting within 30 days (max 3). */
  credits: CreditStatus[];
  /** Planning value of every tracked points balance, in cents. */
  pointsCents: number;
}

function WalletCard({ bonus, credits, pointsCents }: WalletCardProps) {
  const empty = !bonus && credits.length === 0 && pointsCents <= 0;
  const divider = { borderTop: '1px solid var(--border)', paddingTop: 12 } as const;
  let above = false; // whether a section has already been rendered

  const bonusSection = bonus ? (
    <div>
      <p className="small" style={{ marginBottom: 7 }}>
        <strong>{bonus.account.name} bonus</strong> ·{' '}
        <span className="tnum">{fmtUsdWhole(Math.ceil(bonus.remaining))} to go</span>
      </p>
      <div className="progress" style={{ height: 5 }}>
        <div
          className="progress-fill"
          style={{
            width: `${Math.min(100, (bonus.spent / Math.max(1, bonus.tracking.minSpend)) * 100)}%`,
            background: 'var(--accent)',
          }}
        />
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        {daysLeftText(bonus.daysLeft)}
      </p>
    </div>
  ) : null;
  if (bonusSection) above = true;

  const creditsSection =
    credits.length > 0 ? (
      <div style={above ? divider : undefined}>
        <div style={{ display: 'grid', gap: 8 }}>
          {credits.map((c) => (
            <div key={`${c.account.id}:${c.credit.id}:${c.periodKey}`} className="spread" style={{ gap: 8 }}>
              <span
                className="small"
                style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                <strong>{c.credit.name}</strong>{' '}
                <span className="tnum">{creditAmount(c.remaining)}</span>
              </span>
              <span
                className={c.daysLeft <= 7 ? 'badge badge-warn' : 'badge badge-neutral'}
                style={{ whiteSpace: 'nowrap' }}
              >
                {resetsText(c.daysLeft)}
              </span>
            </div>
          ))}
        </div>
      </div>
    ) : null;
  if (creditsSection) above = true;

  const pointsSection =
    pointsCents > 0 ? (
      <div style={above ? divider : undefined}>
        <div className="stat">
          <span className="stat-label">Points worth</span>
          <span className="stat-value sm tnum">{fmtUsdWhole(pointsCents / 100)}</span>
        </div>
      </div>
    ) : null;

  return (
    <div className="card">
      <div className="card-title">Wallet</div>
      {empty ? (
        <p className="small muted">
          Nothing waiting on your cards — track a welcome bonus in Wallet or add a points balance to
          see it here.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {bonusSection}
          {creditsSection}
          {pointsSection}
        </div>
      )}
      <div className="row" style={{ gap: 14, marginTop: 14 }}>
        <HashLink to="/wallet">Open Wallet →</HashLink>
        <HashLink to="/points">Points →</HashLink>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard page

export default function Dashboard() {
  const accounts = useApp((s) => s.accounts);
  const transactions = useApp((s) => s.transactions);
  const budgets = useApp((s) => s.budgets);
  const pointsBalances = useApp((s) => s.pointsBalances);
  const creditUsages = useApp((s) => s.creditUsages);
  const demoLoaded = useApp((s) => s.demoLoaded);

  const monthKey = currentMonthKey();
  const prevKey = addMonths(monthKey, -1);

  const spent = useMemo(() => totalSpending(transactions, monthKey), [transactions, monthKey]);
  const prevSpent = useMemo(() => totalSpending(transactions, prevKey), [transactions, prevKey]);
  const income = useMemo(() => totalIncome(transactions, monthKey), [transactions, monthKey]);

  const rewardsCents = useMemo(
    () =>
      computeEarnings(transactions, accounts)
        .filter((e) => e.monthKey === monthKey)
        .reduce((sum, e) => sum + e.valueCents, 0),
    [transactions, accounts, monthKey],
  );

  const missedCents = useMemo(() => {
    const txnById = new Map(transactions.map((t) => [t.id, t]));
    return computeMissed(transactions, accounts).reduce((sum, m) => {
      const t = txnById.get(m.transactionId);
      return t && monthKeyOf(t.date) === monthKey ? sum + m.deltaValueCents : sum;
    }, 0);
  }, [transactions, accounts, monthKey]);

  const netCash = useMemo(() => {
    const cash = accounts
      .filter((a) => a.type === 'checking' || a.type === 'savings')
      .reduce((s, a) => s + a.balance, 0);
    const debt = accounts.filter((a) => a.type === 'credit').reduce((s, a) => s + a.balance, 0);
    return cash - debt;
  }, [accounts]);

  const spendSeries = useMemo(() => monthlySpendingSeries(transactions, 12), [transactions]);

  const catRows = useMemo<CatRow[]>(
    () => foldCategoryRows(spendingByCategory(transactions, monthKey)),
    [transactions, monthKey],
  );

  const merchants = useMemo(() => topMerchants(transactions, monthKey, 6), [transactions, monthKey]);

  const budgetRows = useMemo(
    () => budgetProgress(transactions, budgets, monthKey).slice(0, 4),
    [transactions, budgets, monthKey],
  );

  // --- Wallet ---------------------------------------------------------------
  const walletBonus = useMemo<BonusProgress | null>(
    () => bonusProgressAll(accounts, transactions).find((b) => b.status === 'in-progress') ?? null,
    [accounts, transactions],
  );

  const walletCredits = useMemo<CreditStatus[]>(
    () =>
      creditsAll(accounts, creditUsages, transactions)
        .filter((c) => c.remaining > 0 && c.daysLeft <= 30)
        .slice(0, 3),
    [accounts, creditUsages, transactions],
  );

  const pointsCents = useMemo(() => totalValueCents(pointsBalances), [pointsBalances]);

  const recent = useMemo<Transaction[]>(
    () => [...transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8),
    [transactions],
  );

  // Spent-vs-last-month delta. Higher spending = bad (up-bad), lower = good.
  let delta: JSX.Element | null = null;
  if (prevSpent > 0) {
    const pct = Math.abs(spent - prevSpent) / prevSpent;
    if (pct < 0.005) {
      delta = <span>about the same as {monthNameLong(prevKey)}</span>;
    } else if (spent > prevSpent) {
      delta = (
        <span>
          <span className="up-bad">↑ {fmtPct(pct)} more</span> than {monthNameLong(prevKey)}
        </span>
      );
    } else {
      delta = (
        <span>
          <span className="up-good">↓ {fmtPct(pct)} less</span> than {monthNameLong(prevKey)}
        </span>
      );
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">{monthLabel(monthKey)}</p>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 16 }}>
        {demoLoaded && (
          <div className="banner">
            <span style={{ flex: 1 }}>
              You&rsquo;re exploring demo data — import your own in Accounts.
            </span>
            <button className="btn btn-ghost" onClick={() => go('/accounts')}>
              Go to Accounts →
            </button>
          </div>
        )}

        {/* Stat row */}
        <div className="grid-4">
          <div className="card">
            <div className="stat">
              <span className="stat-label">Spent this month</span>
              <span className="stat-value tnum">{fmtUsdWhole(spent)}</span>
              {delta && <span className="stat-delta">{delta}</span>}
            </div>
          </div>
          <div className="card">
            <div className="stat">
              <span className="stat-label">Income this month</span>
              <span className="stat-value tnum">{fmtUsdWhole(income)}</span>
            </div>
          </div>
          <div className="card">
            <div className="stat">
              <span className="stat-label">Rewards earned</span>
              <span className="stat-value tnum">{fmtCents(rewardsCents)}</span>
              <span className="stat-delta muted">this month, across your cards</span>
            </div>
          </div>
          <div className="card">
            <div className="stat">
              <span className="stat-label">Net cash</span>
              <span className="stat-value tnum">{fmtUsdWhole(netCash)}</span>
              <span className="stat-delta muted">cash minus card balances</span>
            </div>
          </div>
        </div>

        {/* Spending chart | Where it went */}
        <div className="grid-2">
          <div className="card">
            <div className="card-title">Spending</div>
            <SpendingChart series={spendSeries} monthKey={monthKey} />
          </div>
          <div className="card">
            <div className="card-title">Where it went</div>
            <CategoryBars rows={catRows} />
          </div>
        </div>

        {/* Budgets | Wallet | (Missed rewards + Top merchants) */}
        <div className="grid-3">
          <div className="card">
            <div className="card-title">Budgets</div>
            {budgetRows.length === 0 ? (
              <div className="empty-state">
                <div className="big">🎯</div>
                <p style={{ marginBottom: 14 }}>No budgets yet. Set limits to track your pace.</p>
                <button className="btn btn-primary" onClick={() => go('/budgets')}>
                  Set a budget
                </button>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 14 }}>
                {budgetRows.map((bp) => {
                  const fill =
                    bp.ratio > 1
                      ? 'var(--critical)'
                      : bp.ratio > 0.85
                        ? 'var(--warning)'
                        : categoryDef(bp.categoryId).color;
                  return (
                    <div key={bp.categoryId}>
                      <div className="spread" style={{ marginBottom: 6 }}>
                        <CategoryChip id={bp.categoryId} />
                        <span className="small tnum" style={{ color: 'var(--ink-2)' }}>
                          <strong style={{ color: 'var(--ink)' }}>{fmtUsd(bp.spent)}</strong> of{' '}
                          {fmtUsd(bp.limit)}
                        </span>
                      </div>
                      <div className="progress">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${Math.min(bp.ratio, 1) * 100}%`,
                            background: fill,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
                <a
                  href="#/budgets"
                  className="small"
                  style={{ color: 'var(--accent-strong)', fontWeight: 600, justifySelf: 'start' }}
                >
                  All budgets →
                </a>
              </div>
            )}
          </div>

          <WalletCard bonus={walletBonus} credits={walletCredits} pointsCents={pointsCents} />

          <div className="card">
            <div className="card-title">Missed rewards</div>
            {missedCents > 0 ? (
              <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
                <span className="stat-value tnum" style={{ color: 'var(--critical)' }}>
                  {fmtCents(missedCents)}
                </span>
                <p className="small" style={{ color: 'var(--ink-2)' }}>
                  left on the table this month by using the wrong card
                </p>
                <button className="btn" onClick={() => go('/rewards')}>
                  See which card to use →
                </button>
              </div>
            ) : (
              <p className="small" style={{ color: 'var(--good-text)' }}>
                ✓ No missed rewards this month — your purchases went on the right cards.
              </p>
            )}
          </div>
        </div>

        {/* Top merchants | Recent activity */}
        <div className="grid-2">
          <div className="card">
            <div className="card-title">Top merchants</div>
            {merchants.length === 0 ? (
              <div className="empty-state">
                <div className="big">🏪</div>
                <p>No purchases yet this month.</p>
              </div>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <tbody>
                    {merchants.map((m) => (
                      <tr key={m.merchant}>
                        <td style={{ fontWeight: 600 }}>{m.merchant}</td>
                        <td>
                          <CategoryChip id={m.category} />
                        </td>
                        <td className="num muted">×{m.count}</td>
                        <td className="num tnum">{fmtUsd(m.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent activity */}
          <div className="card">
          <div className="card-title">Recent activity</div>
          {recent.length === 0 ? (
            <div className="empty-state">
              <div className="big">🪶</div>
              <p>Nothing here yet — connect an account or import a CSV in Accounts.</p>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <tbody>
                  {recent.map((t) => (
                    <tr key={t.id}>
                      <td className="muted tnum" style={{ whiteSpace: 'nowrap', width: 72 }}>
                        {fmtDateShort(t.date)}
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        {t.merchant}
                        {t.pending && (
                          <span className="badge badge-neutral" style={{ marginLeft: 8 }}>
                            Pending
                          </span>
                        )}
                      </td>
                      <td>
                        <CategoryChip id={t.category} />
                      </td>
                      <td className="num tnum">
                        {t.amount < 0 ? (
                          <span style={{ color: 'var(--good-text)', fontWeight: 600 }}>
                            +{fmtUsd(-t.amount)}
                          </span>
                        ) : (
                          fmtUsd(t.amount)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
