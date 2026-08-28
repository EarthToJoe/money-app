import { useMemo, useState } from 'react';
import { useApp } from '../store';
import type { Account, CardProduct, CategoryId } from '../types';
import { REWARDABLE_CATEGORY_IDS, categoryDef } from '../data/categories';
import { productById } from '../data/cards';
import {
  bestOwnedCardFor,
  computeEarnings,
  computeMissed,
  recommendNewCards,
  rewardMultiplierFor,
} from '../lib/rewards';
import { currentMonthKey, lastMonthKeys, monthKeyOf } from '../lib/analytics';
import { fmtCents, fmtDateShort, fmtUsd, fmtUsdWhole } from '../lib/format';
import { CardArt } from './rewards/CardArt';
import { EarningsChart } from './rewards/EarningsChart';
import type { EarningsSeries } from './rewards/EarningsChart';

interface OwnedCard {
  account: Account;
  product: CardProduct;
}

/** "1.5" not "1.50"; multipliers are already short numbers. */
function trimNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** "4x" for points/miles, "2%" for cash back. */
function rateLabel(product: CardProduct, multiplier: number): string {
  return product.currency === 'cashback' ? `${trimNum(multiplier)}%` : `${trimNum(multiplier)}x`;
}

/** "6.4¢" — value in cents per $1 of spend. */
function centsPerDollar(cents: number): string {
  return `${trimNum(Math.round(cents * 10) / 10)}¢`;
}

/** Best elevated rate on the card, e.g. "4x dining & drinks" or "2% everything". */
function headlineRate(product: CardProduct): string {
  let best: { multiplier: number; categories: CategoryId[] | 'all' } | null = null;
  for (const rule of product.rules) {
    if (!best || rule.multiplier > best.multiplier) best = rule;
  }
  if (!best) return `${rateLabel(product, product.baseMultiplier)} everything`;
  const label =
    best.categories === 'all'
      ? 'everything'
      : categoryDef(best.categories[0]).label.toLowerCase();
  return `${rateLabel(product, best.multiplier)} ${label}`;
}

function feeLabel(annualFee: number): string {
  return annualFee === 0 ? 'No annual fee' : `${fmtUsdWhole(annualFee)} annual fee`;
}

type MissedPeriod = 'month' | 'quarter';

export default function Rewards() {
  const accounts = useApp((s) => s.accounts);
  const transactions = useApp((s) => s.transactions);

  const [pickedCategory, setPickedCategory] = useState<CategoryId>('dining');
  const [missedPeriod, setMissedPeriod] = useState<MissedPeriod>('month');

  const thisMonth = currentMonthKey();

  const owned: OwnedCard[] = useMemo(
    () =>
      accounts
        .filter((a) => a.type === 'credit' && a.productId)
        .map((account) => ({ account, product: account.productId ? productById(account.productId) : undefined }))
        .filter((x): x is OwnedCard => x.product !== undefined),
    [accounts],
  );

  const earnings = useMemo(() => computeEarnings(transactions, accounts), [transactions, accounts]);
  const missed = useMemo(() => computeMissed(transactions, accounts), [transactions, accounts]);
  const recommendations = useMemo(
    () => recommendNewCards(transactions, accounts).slice(0, 3),
    [transactions, accounts],
  );

  // --- Your cards: cents earned this month per account -----------------------
  const earnedThisMonth = useMemo(() => {
    const byAccount = new Map<string, number>();
    for (const e of earnings) {
      if (e.monthKey !== thisMonth) continue;
      byAccount.set(e.accountId, (byAccount.get(e.accountId) ?? 0) + e.valueCents);
    }
    return byAccount;
  }, [earnings, thisMonth]);

  // --- Which card should I use? ---------------------------------------------
  const best = useMemo(
    () => bestOwnedCardFor(pickedCategory, accounts),
    [pickedCategory, accounts],
  );

  const comparison = useMemo(
    () =>
      owned
        .map(({ account, product }) => {
          const multiplier = rewardMultiplierFor(product, pickedCategory);
          return {
            account,
            product,
            multiplier,
            valuePerDollarCents: multiplier * product.pointValueCents,
          };
        })
        .sort((a, b) => b.valuePerDollarCents - a.valuePerDollarCents),
    [owned, pickedCategory],
  );

  // --- Missed rewards --------------------------------------------------------
  const txnById = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const missedInPeriod = useMemo(() => {
    const monthSet = new Set(missedPeriod === 'month' ? [thisMonth] : lastMonthKeys(3, thisMonth));
    return missed
      .map((m) => ({ ...m, txn: txnById.get(m.transactionId) }))
      .filter((m) => m.txn !== undefined && monthSet.has(monthKeyOf(m.txn.date)))
      .sort((a, b) => b.deltaValueCents - a.deltaValueCents);
  }, [missed, missedPeriod, thisMonth, txnById]);

  const totalMissedCents = missedInPeriod.reduce((s, m) => s + m.deltaValueCents, 0);

  // --- Earnings chart (last 12 months) --------------------------------------
  const chartMonths = useMemo(() => lastMonthKeys(12, thisMonth), [thisMonth]);

  const { chartRows, chartSeries, total12moCents } = useMemo(() => {
    const monthSet = new Set(chartMonths);
    const centsByAccountMonth = new Map<string, number>();
    let total = 0;
    for (const e of earnings) {
      if (!monthSet.has(e.monthKey)) continue;
      const key = `${e.accountId}|${e.monthKey}`;
      centsByAccountMonth.set(key, (centsByAccountMonth.get(key) ?? 0) + e.valueCents);
      total += e.valueCents;
    }
    const rows = chartMonths.map((month) => {
      const row: Record<string, number | string> = { month };
      for (const { account } of owned) {
        row[account.id] = (centsByAccountMonth.get(`${account.id}|${month}`) ?? 0) / 100;
      }
      return row;
    });
    const series: EarningsSeries[] = owned.map(({ account, product }) => ({
      key: account.id,
      name: product.name,
      color: product.gradient[0],
    }));
    return { chartRows: rows, chartSeries: series, total12moCents: total };
  }, [earnings, chartMonths, owned]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Rewards</h1>
          <p className="page-subtitle">Get the most out of every swipe.</p>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* ----------------------------------------------------- Your cards */}
        {owned.length > 0 && (
          <section>
            <h2 className="section-title">Your cards</h2>
            <div className="grid-3">
              {owned.map(({ account, product }) => (
                <CardArt
                  key={account.id}
                  gradient={product.gradient}
                  name={product.name}
                  mask={account.mask}
                  bottom={
                    <div className="spread" style={{ alignItems: 'flex-end' }}>
                      <div>
                        <div
                          style={{
                            fontSize: 'var(--fs-xs)',
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '0.07em',
                            opacity: 0.8,
                          }}
                        >
                          Earned this month
                        </div>
                        <div
                          className="tnum"
                          style={{
                            fontWeight: 700,
                            fontSize: 'var(--fs-md)',
                            textShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
                          }}
                        >
                          {fmtCents(earnedThisMonth.get(account.id) ?? 0)}
                        </div>
                      </div>
                      <div
                        style={{
                          fontSize: 'var(--fs-xs)',
                          fontWeight: 650,
                          background: 'rgba(255, 255, 255, 0.2)',
                          padding: '3px 9px',
                          borderRadius: 999,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {headlineRate(product)}
                      </div>
                    </div>
                  }
                />
              ))}
            </div>
          </section>
        )}

        {/* ------------------------------------------- Which card should I use */}
        <section className="card">
          <div className="card-title">Which card should I use?</div>
          {owned.length === 0 ? (
            <div className="empty-state">
              <div className="big">💳</div>
              <p>No credit cards linked yet.</p>
              <p className="muted small">
                Add a credit card on the Accounts page to see which one to swipe for each category.
              </p>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
                {REWARDABLE_CATEGORY_IDS.map((id) => {
                  const def = categoryDef(id);
                  const active = id === pickedCategory;
                  return (
                    <button
                      key={id}
                      className="chip"
                      onClick={() => setPickedCategory(id)}
                      style={{
                        border: '1px solid transparent',
                        ...(active
                          ? { background: 'var(--ink)', color: 'var(--surface)' }
                          : null),
                      }}
                    >
                      <span className="dot" style={{ background: def.color }} />
                      {def.label}
                    </button>
                  );
                })}
              </div>

              {best ? (
                <div
                  style={{
                    display: 'flex',
                    gap: 20,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    marginBottom: 16,
                  }}
                >
                  <div style={{ width: 230, flex: 'none' }}>
                    <CardArt
                      mini
                      gradient={best.product.gradient}
                      name={best.product.name}
                      mask={best.account.mask}
                    />
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 'var(--fs-xl)',
                        fontWeight: 700,
                        letterSpacing: '-0.01em',
                      }}
                    >
                      Use your {best.product.name}
                    </div>
                    <div className="muted" style={{ marginTop: 2 }}>
                      {rateLabel(best.product, best.multiplier)} ≈{' '}
                      {centsPerDollar(best.valuePerDollarCents)} per $1 on{' '}
                      {categoryDef(pickedCategory).label.toLowerCase()}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="muted small" style={{ marginBottom: 12 }}>
                  No reward data for this category yet.
                </p>
              )}

              {comparison.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <div className="table-scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Card</th>
                          <th className="num">Rate</th>
                          <th className="num">Value per $1</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.map(({ account, product, multiplier, valuePerDollarCents }, i) => (
                          <tr key={account.id}>
                            <td>
                              <span className="row" style={{ gap: 8 }}>
                                <span
                                  style={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: '50%',
                                    background: product.gradient[0],
                                    flex: 'none',
                                  }}
                                />
                                {product.name}
                                <span className="muted small tnum">•••• {account.mask}</span>
                                {i === 0 && comparison.length > 1 && (
                                  <span className="badge badge-good">Best</span>
                                )}
                              </span>
                            </td>
                            <td className="num">{rateLabel(product, multiplier)}</td>
                            <td className="num">{centsPerDollar(valuePerDollarCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <p className="muted small" style={{ marginTop: 12 }}>
                Shopping somewhere specific, or deciding cash vs points?{' '}
                <a
                  href="#/advisor"
                  style={{ color: 'var(--accent-strong)', fontWeight: 600 }}
                  onClick={(e) => {
                    e.preventDefault();
                    window.location.hash = '/advisor';
                  }}
                >
                  Open the Advisor →
                </a>
              </p>
            </>
          )}
        </section>

        {/* ------------------------------------------------- Missed rewards */}
        <section className="card">
          <div className="spread" style={{ marginBottom: 14 }}>
            <div className="card-title" style={{ marginBottom: 0 }}>
              Missed rewards
            </div>
            <div className="segmented">
              <button
                className={missedPeriod === 'month' ? 'active' : ''}
                onClick={() => setMissedPeriod('month')}
              >
                This month
              </button>
              <button
                className={missedPeriod === 'quarter' ? 'active' : ''}
                onClick={() => setMissedPeriod('quarter')}
              >
                Last 3 months
              </button>
            </div>
          </div>

          {owned.length === 0 ? (
            <p className="muted small">
              Link a credit card to see where a different card would have earned more.
            </p>
          ) : missedInPeriod.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0' }}>
              <span className="badge badge-good">You used the best card for everything. 🎯</span>
            </div>
          ) : (
            <>
              <div className="stat" style={{ marginBottom: 14 }}>
                <span className="stat-label">
                  {missedPeriod === 'month' ? 'Missed this month' : 'Missed, last 3 months'}
                </span>
                <span className="stat-value sm">{fmtCents(totalMissedCents)}</span>
                <span className="stat-delta">
                  {missedInPeriod.length} purchase{missedInPeriod.length === 1 ? '' : 's'} where
                  another card earned more
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Merchant</th>
                        <th className="num">Amount</th>
                        <th>Used</th>
                        <th>Best</th>
                        <th className="num">Missed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {missedInPeriod.slice(0, 12).map((m) => {
                        const txn = m.txn!;
                        const usedName = accountById.get(m.usedAccountId)?.name ?? '—';
                        const bestName =
                          accountById.get(m.bestAccountId)?.name ??
                          productById(m.bestProductId)?.name ??
                          '—';
                        return (
                          <tr key={m.transactionId}>
                            <td className="muted tnum" style={{ whiteSpace: 'nowrap' }}>
                              {fmtDateShort(txn.date)}
                            </td>
                            <td>{txn.merchant}</td>
                            <td className="num">{fmtUsd(txn.amount)}</td>
                            <td className="muted">{usedName}</td>
                            <td>{bestName}</td>
                            <td className="num" style={{ color: 'var(--critical)', fontWeight: 600 }}>
                              −{fmtCents(m.deltaValueCents)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </section>

        {/* ------------------------------------------------------- Earnings */}
        <section className="card">
          <div className="card-title">Earnings</div>
          {owned.length === 0 || total12moCents === 0 ? (
            <div className="empty-state">
              <div className="big">✨</div>
              <p>No rewards earned yet.</p>
              <p className="muted small">
                Earnings show up here once there's credit-card spending to count.
              </p>
            </div>
          ) : (
            <>
              <div className="stat" style={{ marginBottom: 16 }}>
                <span className="stat-label">Earned, last 12 months</span>
                <span className="stat-value sm">{fmtCents(total12moCents)}</span>
              </div>
              <EarningsChart rows={chartRows} series={chartSeries} />
            </>
          )}
        </section>

        {/* --------------------------------------------- Cards worth a look */}
        <section className="card">
          <div className="card-title">Cards worth a look</div>
          <p className="muted small" style={{ marginTop: -8, marginBottom: 14 }}>
            What each card would add on top of the cards you already have, based on your last 6
            months of spending — ranked by estimated two-year gain.
          </p>
          {recommendations.length === 0 ? (
            <div className="empty-state">
              <div className="big">🔎</div>
              <p>No recommendations yet.</p>
              <p className="muted small">
                Once there's spending history to analyze, cards that beat your current lineup show
                up here.
              </p>
            </div>
          ) : (
            <div className="grid-3">
              {recommendations.map((rec) => (
                <div
                  key={rec.product.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-md)',
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <CardArt mini gradient={rec.product.gradient} name={rec.product.name} />
                  <div>
                    <div style={{ fontWeight: 650 }}>{rec.product.name}</div>
                    <div className="muted small">
                      {rec.product.issuer} · {feeLabel(rec.product.annualFee)}
                    </div>
                  </div>
                  <div className="spread">
                    <span className="muted small">First-year gain</span>
                    {rec.firstYearValueCents > 0 ? (
                      <span
                        className="badge badge-good tnum"
                        style={{ fontSize: 'var(--fs-sm)', fontWeight: 700 }}
                      >
                        {fmtCents(rec.firstYearValueCents)}
                      </span>
                    ) : (
                      <span className="tnum" style={{ fontWeight: 700 }}>
                        {fmtCents(rec.firstYearValueCents)}
                      </span>
                    )}
                  </div>
                  <div className="spread">
                    <span className="muted small">Ongoing gain, per year</span>
                    <span
                      className="tnum small"
                      style={{
                        fontWeight: 600,
                        color: rec.annualValueCents < 0 ? 'var(--critical)' : undefined,
                      }}
                    >
                      {rec.annualValueCents < 0 ? '−' : ''}
                      {fmtCents(Math.abs(rec.annualValueCents))}
                    </span>
                  </div>
                  <p className="muted small" style={{ lineHeight: 1.45 }}>
                    {rec.reason}
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 'auto' }}>
                    {rec.product.highlights.map((h) => (
                      <span key={h} className="chip chip-wrap">
                        {h}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="muted small" style={{ marginTop: 14 }}>
            Estimates from your actual spending and published reward rates. Not financial advice —
            verify terms with the issuer.
          </p>
        </section>
      </div>
    </div>
  );
}
