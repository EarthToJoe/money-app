import { useMemo, useRef } from 'react';
import { useApp } from '../store';
import type { Account, CardProduct } from '../types';
import { productById } from '../data/cards';
import { bonusProgressAll } from '../lib/bonus';
import { creditsAll, creditsForAccount } from '../lib/credits';
import type { PortfolioValue } from '../lib/cardValue';
import { cardValueAll, portfolioValue } from '../lib/cardValue';
import { fmtCents } from '../lib/format';
import { BonusHero } from './wallet/BonusHero';
import { CreditsDue } from './wallet/CreditsDue';
import { CardTile } from './wallet/CardTile';
import { todayIso } from './wallet/helpers';

/**
 * Asked once, then never again: the published fee is not always the price.
 * Offered as one question with two plain answers rather than an assumption
 * about who the cardholder is.
 */
function FeeQuestion({ onAnswer }: { onAnswer: (waived: boolean) => void }) {
  return (
    <div className="banner" style={{ alignItems: 'flex-start', flexWrap: 'wrap', rowGap: 10 }}>
      <div style={{ flex: '1 1 300px', minWidth: 0 }}>
        <div>Do you pay annual fees?</div>
        <div className="small muted" style={{ marginTop: 3, fontWeight: 500 }}>
          Military SCRA, retention offers and first-year-free promos all mean the published fee isn't what you pay.
        </div>
      </div>
      <div className="row" style={{ gap: 8, flex: 'none' }}>
        <button className="btn" onClick={() => onAnswer(false)}>
          I pay them
        </button>
        <button className="btn" onClick={() => onAnswer(true)}>
          They're waived
        </button>
      </div>
    </div>
  );
}

interface PortfolioSummaryProps {
  totals: PortfolioValue;
  /** Face value of every credit period that fell in the window. */
  creditsAvailableCents: number;
  cards: number;
}

/**
 * Wallet-wide totals. No verdict on any card — just what came back, plus the
 * one number that is a genuine loss whatever the fee situation: credits that
 * were on offer and expired unused.
 */
function PortfolioSummary({ totals, creditsAvailableCents, cards }: PortfolioSummaryProps) {
  const left = totals.creditsLeftOnTableCents;

  return (
    <div className="card">
      <div className="card-title">What your cards returned</div>

      <div className="grid-3">
        <div className="stat">
          <span className="stat-label">Rewards earned</span>
          <span className="stat-value sm tnum">{fmtCents(totals.rewardValueCents)}</span>
          {totals.bonusValueCents > 0 && (
            <span className="small muted">plus {fmtCents(totals.bonusValueCents)} in welcome bonuses</span>
          )}
        </div>

        <div className="stat">
          <span className="stat-label">Credits used</span>
          <span className="stat-value sm tnum">{fmtCents(totals.creditsUsedCents)}</span>
          {creditsAvailableCents > 0 && (
            <span className="small muted">of {fmtCents(creditsAvailableCents)} available</span>
          )}
        </div>

        <div className="stat">
          <span className="stat-label">Credits left on the table</span>
          <span className="stat-value tnum" style={{ color: left > 0 ? 'var(--critical)' : undefined }}>
            {fmtCents(left)}
          </span>
          <span className="small muted">
            {left > 0
              ? 'Unused credits expire when their period resets.'
              : creditsAvailableCents > 0
                ? 'You used every credit that came due.'
                : 'No credit periods have come due in this window yet.'}
          </span>
        </div>
      </div>

      <p className="small muted" style={{ marginTop: 14 }}>
        Last 12 months across {cards} {cards === 1 ? 'card' : 'cards'}.
      </p>
    </div>
  );
}

export default function Wallet() {
  const accounts = useApp((s) => s.accounts);
  const transactions = useApp((s) => s.transactions);
  const creditUsages = useApp((s) => s.creditUsages);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);

  const cardsRef = useRef<HTMLDivElement>(null);
  const today = todayIso();

  const creditAccounts = useMemo(() => accounts.filter((a) => a.type === 'credit'), [accounts]);

  const bonuses = useMemo(
    () => bonusProgressAll(accounts, transactions, today),
    [accounts, transactions, today],
  );
  const inProgress = bonuses.filter((b) => b.status === 'in-progress');

  const trackable = useMemo(
    () =>
      creditAccounts
        .filter((a) => !a.bonus)
        .map((account) => ({ account, product: account.productId ? productById(account.productId) : undefined }))
        .filter((x): x is { account: Account; product: CardProduct } => x.product?.signupBonus !== undefined),
    [creditAccounts],
  );

  const allCredits = useMemo(
    () => creditsAll(accounts, creditUsages, transactions, today),
    [accounts, creditUsages, transactions, today],
  );

  // What each card returned over the trailing year. Cards with no linked
  // product drop out here, so the totals never count a card we can't value.
  const values = useMemo(
    () => cardValueAll(creditAccounts, { transactions, creditUsages, settings, today }),
    [creditAccounts, transactions, creditUsages, settings, today],
  );
  const valueByAccount = useMemo(() => new Map(values.map((v) => [v.account.id, v])), [values]);
  const totals = useMemo(() => portfolioValue(values), [values]);
  const creditsAvailableCents = useMemo(
    () => values.reduce((sum, v) => sum + v.creditsAvailableCents, 0),
    [values],
  );
  // A wallet of day-old cards has nothing to total up yet; a card of zeros
  // would read as a bad year rather than a new one.
  const hasReturns = useMemo(
    () =>
      values.some(
        (v) =>
          v.rewardValueCents > 0 ||
          v.creditsUsedCents > 0 ||
          v.creditsAvailableCents > 0 ||
          v.bonusValueCents > 0,
      ),
    [values],
  );

  if (creditAccounts.length === 0) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1 className="page-title">Wallet</h1>
            <p className="page-subtitle">Your cards, welcome bonuses, and credits — in one place.</p>
          </div>
        </div>
        <div className="card">
          <div className="empty-state">
            <div className="big">💳</div>
            <p>No credit cards yet.</p>
            <p className="small muted" style={{ marginTop: 4 }}>
              Add a card on the <a href="#/accounts">Accounts page</a> and it shows up here with its bonus and credits.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Wallet</h1>
          <p className="page-subtitle">Your cards, welcome bonuses, and credits — in one place.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 16 }}>
        {settings.waiveAnnualFees === undefined && (
          <FeeQuestion onAnswer={(waived) => updateSettings({ waiveAnnualFees: waived })} />
        )}

        <BonusHero
          inProgress={inProgress}
          trackable={trackable}
          onJumpToCards={() => cardsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        />

        <CreditsDue credits={allCredits} />

        {hasReturns && (
          <PortfolioSummary
            totals={totals}
            creditsAvailableCents={creditsAvailableCents}
            cards={values.length}
          />
        )}

        <div ref={cardsRef}>
          <div className="section-title">Your cards</div>
          <div className="grid-2">
            {creditAccounts.map((account) => {
              const product = account.productId ? productById(account.productId) : undefined;
              return (
                <CardTile
                  key={account.id}
                  account={account}
                  product={product}
                  bonus={bonuses.find((b) => b.account.id === account.id) ?? null}
                  credits={creditsForAccount(account, creditUsages, transactions, today)}
                  value={valueByAccount.get(account.id) ?? null}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
