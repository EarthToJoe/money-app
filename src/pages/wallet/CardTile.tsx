import { useState } from 'react';
import { useApp } from '../../store';
import type { Account, CardProduct } from '../../types';
import type { BonusProgress } from '../../lib/bonus';
import { defaultBonusTracking } from '../../lib/bonus';
import type { CreditStatus } from '../../lib/credits';
import type { CardValue } from '../../lib/cardValue';
import { fmtDateShort, fmtUsd, fmtUsdWhole } from '../../lib/format';
import { CardArt } from '../rewards/CardArt';
import { MarkUsed } from './MarkUsed';
import { CardValueCard } from './CardValueCard';
import { FeeOverride } from './FeeOverride';
import {
  BONUS_STATUS_BADGE,
  BONUS_STATUS_LABEL,
  FALLBACK_GRADIENT,
  bonusPointsLabel,
  programLabel,
  todayIso,
} from './helpers';

interface CardTileProps {
  account: Account;
  product?: CardProduct;
  bonus: BonusProgress | null;
  credits: CreditStatus[];
  /** What the card returned over the value window; null when there is nothing to measure. */
  value: CardValue | null;
}

interface BonusDraft {
  points: string;
  minSpend: string;
  deadline: string;
}

/** One credit-card account: art, opened date, bonus tracking, credits, and what it returned. */
export function CardTile({ account, product, bonus, credits, value }: CardTileProps) {
  const updateAccount = useApp((s) => s.updateAccount);
  const setAccountBonus = useApp((s) => s.setAccountBonus);

  const [draft, setDraft] = useState<BonusDraft | null>(null);

  const gradient = product?.gradient ?? FALLBACK_GRADIENT;

  const openEditor = () => {
    const seed = account.bonus ?? (product && account.openedAt ? defaultBonusTracking(product, account.openedAt) : null);
    setDraft({
      points: String(seed?.points ?? product?.signupBonus?.points ?? ''),
      minSpend: String(seed?.minSpend ?? product?.signupBonus?.minSpend ?? ''),
      deadline: seed?.deadline ?? '',
    });
  };

  const saveDraft = () => {
    if (!draft) return;
    const points = Number(draft.points);
    const minSpend = Number(draft.minSpend);
    if (!Number.isFinite(points) || points <= 0 || !Number.isFinite(minSpend) || minSpend <= 0 || !draft.deadline) return;
    const startDate = account.bonus?.startDate ?? account.openedAt ?? todayIso();
    // Saving re-evaluates status from actual spend — no stale earned/abandoned flag.
    setAccountBonus(account.id, { points, minSpend, startDate, deadline: draft.deadline });
    setDraft(null);
  };

  const trackDefault = () => {
    if (!product || !account.openedAt) return;
    const tracking = defaultBonusTracking(product, account.openedAt);
    if (tracking) setAccountBonus(account.id, tracking);
  };

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <CardArt gradient={gradient} name={product?.name ?? account.name} mask={account.mask} />

      <div className="row" style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <span className="small muted">{account.institution}</span>
        {product ? (
          <FeeOverride account={account} product={product} />
        ) : (
          <span className="small muted">No linked product</span>
        )}
        {product && (
          <span className="chip">
            <span className="dot" style={{ background: gradient[0] }} />
            {programLabel(product)}
          </span>
        )}
      </div>

      <label className="row small" style={{ gap: 8 }}>
        <span className="muted" style={{ flex: 'none' }}>
          Opened
        </span>
        <input
          type="date"
          className="input"
          value={account.openedAt ?? ''}
          onChange={(e) => updateAccount(account.id, { openedAt: e.target.value || undefined })}
          style={{ padding: '4px 8px' }}
          aria-label={`Date ${account.name} was opened`}
        />
      </label>

      {!product ? (
        <p className="small muted">Link a card product on the Accounts page to track bonuses and credits.</p>
      ) : (
        <>
          {/* ---- Welcome bonus ---- */}
          <div>
            <div className="section-title" style={{ marginBottom: 6 }}>
              Welcome bonus
            </div>
            {draft ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  saveDraft();
                }}
                style={{ display: 'grid', gap: 8 }}
              >
                <div className="row" style={{ flexWrap: 'wrap', rowGap: 8 }}>
                  <label className="small" style={{ display: 'grid', gap: 2 }}>
                    <span className="muted">{product.currency === 'cashback' ? 'Bonus (cents)' : 'Points'}</span>
                    <input
                      className="input tnum"
                      type="number"
                      min={1}
                      value={draft.points}
                      onChange={(e) => setDraft({ ...draft, points: e.target.value })}
                      style={{ width: 110, padding: '4px 8px' }}
                    />
                  </label>
                  <label className="small" style={{ display: 'grid', gap: 2 }}>
                    <span className="muted">Min spend ($)</span>
                    <input
                      className="input tnum"
                      type="number"
                      min={1}
                      value={draft.minSpend}
                      onChange={(e) => setDraft({ ...draft, minSpend: e.target.value })}
                      style={{ width: 110, padding: '4px 8px' }}
                    />
                  </label>
                  <label className="small" style={{ display: 'grid', gap: 2 }}>
                    <span className="muted">Deadline</span>
                    <input
                      className="input"
                      type="date"
                      value={draft.deadline}
                      onChange={(e) => setDraft({ ...draft, deadline: e.target.value })}
                      style={{ padding: '4px 8px' }}
                    />
                  </label>
                </div>
                <div className="row">
                  <button type="submit" className="btn btn-primary" style={{ padding: '4px 12px' }}>
                    Save
                  </button>
                  <button type="button" className="btn btn-ghost" style={{ padding: '4px 10px' }} onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                  {account.bonus && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-danger"
                      style={{ padding: '4px 10px' }}
                      onClick={() => {
                        setAccountBonus(account.id, undefined);
                        setDraft(null);
                      }}
                    >
                      Remove tracking
                    </button>
                  )}
                </div>
              </form>
            ) : bonus ? (
              <div style={{ display: 'grid', gap: 6 }}>
                <div className="spread">
                  <span className="small tnum">
                    {fmtUsd(bonus.spent)} of {fmtUsdWhole(bonus.tracking.minSpend)}
                    {bonus.status === 'in-progress' && ` · by ${fmtDateShort(bonus.tracking.deadline)}`}
                  </span>
                  <span className={BONUS_STATUS_BADGE[bonus.status]}>{BONUS_STATUS_LABEL[bonus.status]}</span>
                </div>
                <div className="progress">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${Math.min(100, (bonus.spent / Math.max(1, bonus.tracking.minSpend)) * 100)}%`,
                      background: bonus.status === 'earned' ? 'var(--good)' : 'var(--accent)',
                    }}
                  />
                </div>
                <div className="spread">
                  <span className="small muted">
                    {bonusPointsLabel(product, bonus.tracking.points)} ≈ {fmtUsdWhole(bonus.valueCents / 100)}
                  </span>
                  <button className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={openEditor}>
                    Edit
                  </button>
                </div>
              </div>
            ) : product.signupBonus ? (
              <div className="row" style={{ flexWrap: 'wrap', rowGap: 6 }}>
                <button className="btn" onClick={trackDefault} disabled={!account.openedAt}>
                  Track welcome bonus
                </button>
                <button className="btn btn-ghost" style={{ padding: '4px 10px' }} onClick={openEditor}>
                  Custom…
                </button>
                <span className="small muted">
                  {account.openedAt
                    ? `${bonusPointsLabel(product, product.signupBonus.points)} after ${fmtUsdWhole(product.signupBonus.minSpend)} in ${product.signupBonus.months} months`
                    : 'Set the opened date to start tracking.'}
                </span>
              </div>
            ) : (
              <p className="small muted">No public welcome offer modeled for this card.</p>
            )}
          </div>

          {/* ---- Credits ---- */}
          <div>
            <div className="section-title" style={{ marginBottom: 6 }}>
              Credits
            </div>
            {credits.length === 0 ? (
              <p className="small muted">No statement credits on this card.</p>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {credits.map((c) => (
                  <div key={`${c.credit.id}:${c.periodKey}`} className="spread" style={{ flexWrap: 'wrap', rowGap: 4 }}>
                    <div style={{ minWidth: 0 }}>
                      <span className="small" style={{ fontWeight: 600 }}>
                        {c.credit.name}
                      </span>{' '}
                      <span className="small muted tnum">
                        {fmtUsd(c.remaining)} of {fmtUsd(c.credit.amount)} · {c.periodLabel} · ends{' '}
                        {fmtDateShort(c.periodEnds)}
                      </span>
                    </div>
                    <MarkUsed status={c} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <CardValueCard account={account} product={product} value={value} />
        </>
      )}
    </div>
  );
}
