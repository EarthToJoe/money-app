import { useMemo } from 'react';
import { useApp } from '../store';
import type { PurchaseContext } from '../lib/advisor';
import { PurchaseLookup } from './advisor/PurchaseLookup';
import { BigPurchasePlanner } from './advisor/BigPurchasePlanner';
import { AskFinch } from './advisor/AskFinch';

export default function Advisor() {
  const accounts = useApp((s) => s.accounts);
  const transactions = useApp((s) => s.transactions);
  const creditUsages = useApp((s) => s.creditUsages);
  const pointsBalances = useApp((s) => s.pointsBalances);

  const ctx: PurchaseContext = useMemo(
    () => ({ accounts, transactions, creditUsages, pointsBalances }),
    [accounts, transactions, creditUsages, pointsBalances],
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Advisor</h1>
          <p className="page-subtitle">Which card to use, and whether to spend points.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 16 }}>
        <PurchaseLookup ctx={ctx} />
        <BigPurchasePlanner ctx={ctx} />
        <AskFinch />
      </div>
    </div>
  );
}
