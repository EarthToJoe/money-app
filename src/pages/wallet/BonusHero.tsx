import { useApp } from '../../store';
import type { Account, CardProduct } from '../../types';
import type { BonusProgress } from '../../lib/bonus';
import { fmtCents, fmtDateShort, fmtUsd, fmtUsdWhole } from '../../lib/format';
import { CardArt } from '../rewards/CardArt';
import { bonusPointsLabel, daysLeftLabel } from './helpers';

interface BonusHeroProps {
  inProgress: BonusProgress[];
  /** Credit cards with a product signupBonus but no tracking yet. */
  trackable: Array<{ account: Account; product: CardProduct }>;
  /** Scroll down to the cards section (where tracking is set up). */
  onJumpToCards: () => void;
}

function perDayLabel(p: BonusProgress): string {
  if (p.neededPerDay <= 0) return '';
  return ` · ~${fmtUsdWhole(Math.ceil(p.neededPerDay))}/day`;
}

/** Hero: every welcome bonus currently in progress, with the plain-spoken plan. */
export function BonusHero({ inProgress, trackable, onJumpToCards }: BonusHeroProps) {
  const setAccountBonus = useApp((s) => s.setAccountBonus);

  if (inProgress.length === 0) {
    return (
      <div className="card">
        <div className="card-title">Welcome bonus</div>
        <div className="spread" style={{ flexWrap: 'wrap' }}>
          <p className="small muted">No welcome bonus in progress — your spending is free to chase category rates.</p>
          {trackable.length > 0 && (
            <button className="btn" onClick={onJumpToCards}>
              Track a bonus ↓
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">Welcome bonus</div>
      <div style={{ display: 'grid', gap: 20 }}>
        {inProgress.map((p) => (
          <div
            key={p.account.id}
            className="split-media"
          >
            <CardArt mini gradient={p.product.gradient} name={p.product.name} mask={p.account.mask} />
            <div style={{ display: 'grid', gap: 8 }}>
              <div className="stat">
                <span className="stat-label">{p.product.name}</span>
                <span className="stat-value tnum">{fmtUsdWhole(Math.ceil(p.remaining))} to go</span>
              </div>
              <div className="progress" style={{ maxWidth: 460 }}>
                <div
                  className="progress-fill"
                  style={{
                    width: `${Math.min(100, (p.spent / Math.max(1, p.tracking.minSpend)) * 100)}%`,
                    background: 'var(--accent)',
                  }}
                />
              </div>
              <p className="small">
                Spend {fmtUsdWhole(p.tracking.minSpend)} by {fmtDateShort(p.tracking.deadline)} —{' '}
                {daysLeftLabel(p.daysLeft)}
                {perDayLabel(p)}
              </p>
              <p className="small muted tnum">
                Worth ≈ {fmtUsdWhole(p.valueCents / 100)} ({bonusPointsLabel(p.product, p.tracking.points)}) ·{' '}
                {fmtUsd(p.spent)} of {fmtUsdWhole(p.tracking.minSpend)} done
              </p>
              <p className="small">
                Put everyday spend on this card until it's done — at {fmtCents(Math.round(p.boostPerDollarCents))}{' '}
                of bonus value per dollar, it out-earns every category bonus you have.
              </p>
              <div className="row" style={{ marginTop: 2 }}>
                <button
                  className="btn"
                  onClick={() => setAccountBonus(p.account.id, { ...p.tracking, status: 'earned' })}
                  title="The bonus posted — stop counting"
                >
                  Mark earned
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setAccountBonus(p.account.id, { ...p.tracking, status: 'abandoned' })}
                  title="Keep the record but stop pursuing it"
                >
                  Stop tracking
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 14 }}>
        Not financial advice — verify terms with the issuer.
      </p>
    </div>
  );
}
