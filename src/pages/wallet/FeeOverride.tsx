import { useState } from 'react';
import { useApp } from '../../store';
import type { Account, CardProduct } from '../../types';
import { effectiveAnnualFee, isFeeWaived } from '../../lib/cardValue';
import { fmtUsdWhole } from '../../lib/format';

interface FeeOverrideProps {
  account: Account;
  product: CardProduct;
}

/**
 * The annual fee as this cardholder actually pays it.
 *
 * Precedence lives in src/lib/cardValue.ts: the per-card override wins over the
 * app-wide "fees are waived" setting, which wins over the product's published
 * fee. A waived fee is never shown as a bare "$0" — it carries the word
 * "waived" and the published price beside it, so the number can't be mistaken
 * for what the card actually costs on the open market.
 */
export function FeeOverride({ account, product }: FeeOverrideProps) {
  const updateAccount = useApp((s) => s.updateAccount);
  const settings = useApp((s) => s.settings);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // Dollars per year — same unit as CardProduct.annualFee.
  const fee = effectiveAnnualFee(product, account, settings);
  const waived = isFeeWaived(product, account, settings);
  // Only worth the extra words when the published price is a different number.
  const showPublished = product.annualFee > 0 && fee !== product.annualFee;

  const startEditing = () => {
    setDraft(account.annualFeeOverride === undefined ? '' : String(account.annualFeeOverride));
    setEditing(true);
  };

  const commit = (raw: string) => {
    setDraft(raw);
    const trimmed = raw.trim();
    if (trimmed === '') {
      // Blank clears the override, falling back to the app-wide setting.
      updateAccount(account.id, { annualFeeOverride: undefined });
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 0) updateAccount(account.id, { annualFeeOverride: n });
  };

  return (
    <span className="row small" style={{ gap: 6, flexWrap: 'wrap', rowGap: 4 }}>
      {waived ? (
        <>
          <span className="tnum">{fmtUsdWhole(0)}</span>
          <span className="badge badge-neutral">waived</span>
        </>
      ) : (
        <span className="tnum">{fee > 0 ? `${fmtUsdWhole(fee)}/yr` : 'No annual fee'}</span>
      )}

      {showPublished && <span className="muted">published {fmtUsdWhole(product.annualFee)}</span>}

      {editing ? (
        <>
          <label className="row" style={{ gap: 4 }}>
            <span className="muted">you pay $</span>
            <input
              className="input tnum"
              type="number"
              min={0}
              step={5}
              inputMode="decimal"
              value={draft}
              placeholder={String(product.annualFee)}
              onChange={(e) => commit(e.target.value)}
              style={{ width: 82, padding: '2px 8px' }}
              aria-label={`Annual fee you pay on ${account.name}`}
            />
          </label>
          <button className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={() => setEditing(false)}>
            Done
          </button>
          <span className="muted" style={{ flexBasis: '100%' }}>
            Leave it blank to use your app-wide fee setting.
          </span>
        </>
      ) : (
        <button className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={startEditing}>
          Change
        </button>
      )}
    </span>
  );
}
