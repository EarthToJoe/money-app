import { useMemo, useRef, useState } from 'react';
import type { CategoryId } from '../../types';
import { CATEGORIES, categoryDef } from '../../data/categories';
import { searchMerchants, type MerchantEntry } from '../../data/merchants';
import { advisePurchase, resolveTarget, type PurchaseContext, type PurchaseTarget } from '../../lib/advisor';
import { fmtCents } from '../../lib/format';
import { CardArt } from '../rewards/CardArt';
import { ChipButton, Disclaimer, rateLabel } from './bits';

const QUICK_PICKS = ['Costco', 'Amazon', 'Uber', 'United', 'Whole Foods', 'Airbnb'];

type CategoryChoice = 'auto' | CategoryId;

export function PurchaseLookup({ ctx }: { ctx: PurchaseContext }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MerchantEntry | null>(null);
  const [amountText, setAmountText] = useState('100');
  const [catChoice, setCatChoice] = useState<CategoryChoice>('auto');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(
    () => (open && query.trim() ? searchMerchants(query, 6) : []),
    [open, query],
  );

  const amount = useMemo(() => {
    const n = parseFloat(amountText);
    return Number.isFinite(n) && n > 0 ? n : 100;
  }, [amountText]);

  const advice = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    let target: PurchaseTarget =
      selected && selected.name.toLowerCase() === q.toLowerCase()
        ? { label: selected.name, category: selected.category, merchant: selected }
        : resolveTarget(q);
    if (catChoice !== 'auto') target = { ...target, category: catChoice };
    return advisePurchase(target, amount, ctx);
  }, [query, selected, catChoice, amount, ctx]);

  const addRecent = (label: string) => {
    const clean = label.trim();
    if (!clean) return;
    setRecent((r) => [clean, ...r.filter((x) => x.toLowerCase() !== clean.toLowerCase())].slice(0, 6));
  };

  const pickMerchant = (m: MerchantEntry) => {
    setQuery(m.name);
    setSelected(m);
    setOpen(false);
    setHi(-1);
    addRecent(m.name);
  };

  const runLookup = (label: string) => {
    const hits = searchMerchants(label, 1);
    const exact = hits.find((h) => h.name.toLowerCase() === label.toLowerCase()) ?? hits[0] ?? null;
    setQuery(exact ? exact.name : label);
    setSelected(exact);
    setOpen(false);
    setHi(-1);
    addRecent(exact ? exact.name : label);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHi((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hi >= 0 && suggestions[hi]) pickMerchant(suggestions[hi]);
      else {
        setOpen(false);
        addRecent(query);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setHi(-1);
    }
  };

  const hasQuery = query.trim().length > 0;
  const best = advice?.best ?? null;
  const targetCat = advice ? categoryDef(advice.target.category) : null;

  return (
    <div className="card">
      <div className="card-title">Where are you buying?</div>

      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
          <label className="small muted" htmlFor="advisor-merchant" style={{ display: 'block', marginBottom: 4 }}>
            Merchant or website
          </label>
          <input
            id="advisor-merchant"
            ref={inputRef}
            className="input"
            style={{ width: '100%' }}
            placeholder="Costco, united.com, Uber, dinner…"
            value={query}
            autoComplete="off"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
              setOpen(true);
              setHi(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // Delay so a mousedown on a suggestion still registers.
              window.setTimeout(() => setOpen(false), 120);
            }}
            onKeyDown={onKeyDown}
          />
          {suggestions.length > 0 && (
            <div
              role="listbox"
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                marginTop: 4,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                boxShadow: 'var(--shadow-lg)',
                overflow: 'hidden',
                zIndex: 30,
              }}
            >
              {suggestions.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={i === hi}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMerchant(m);
                  }}
                  onMouseEnter={() => setHi(i)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    textAlign: 'left',
                    border: 0,
                    background: i === hi ? 'var(--surface-2)' : 'transparent',
                    padding: '8px 12px',
                    fontSize: 'var(--fs-sm)',
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{m.name}</span>
                  <span className="small muted">{categoryDef(m.category).label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="small muted" htmlFor="advisor-amount" style={{ display: 'block', marginBottom: 4 }}>
            Amount
          </label>
          <div className="row" style={{ gap: 6 }}>
            <span className="muted">$</span>
            <input
              id="advisor-amount"
              className="input tnum"
              style={{ width: 100 }}
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="small muted" htmlFor="advisor-category" style={{ display: 'block', marginBottom: 4 }}>
            Category
          </label>
          <select
            id="advisor-category"
            className="select"
            value={catChoice}
            onChange={(e) => setCatChoice(e.target.value as CategoryChoice)}
          >
            <option value="auto">Auto-detect</option>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.emoji} {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {recent.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
          <span className="small muted">Recent:</span>
          {recent.map((r) => (
            <ChipButton key={r} onClick={() => runLookup(r)}>
              {r}
            </ChipButton>
          ))}
        </div>
      )}

      {!hasQuery ? (
        <div className="empty-state" style={{ padding: '36px 24px' }}>
          <div className="big">💳</div>
          <p>Type a merchant and Finch ranks every card in your wallet.</p>
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center', marginTop: 12 }}>
            {QUICK_PICKS.map((q) => (
              <ChipButton key={q} onClick={() => runLookup(q)}>
                {q}
              </ChipButton>
            ))}
          </div>
        </div>
      ) : advice && advice.options.length === 0 ? (
        <div className="empty-state" style={{ padding: '32px 24px' }}>
          <div className="big">🪪</div>
          <p>No cards to rank yet. Link a credit card on the Accounts page and come back.</p>
        </div>
      ) : advice ? (
        <div style={{ marginTop: 16 }}>
          {best ? (
            <div className="row" style={{ alignItems: 'stretch', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ width: 200, flex: 'none' }}>
                <CardArt gradient={best.product.gradient} name={best.product.name} mask={best.account.mask} mini />
              </div>
              <div style={{ flex: '1 1 260px' }}>
                <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, letterSpacing: '-0.01em' }}>
                  Use your {best.account.name}
                </div>
                <div className="small muted" style={{ marginTop: 2 }}>
                  {advice.target.label} · {fmtCents(best.totalValueCents)} back on ${advice.amount}
                  {targetCat ? ` · ${targetCat.label.toLowerCase()}` : ''}
                </div>
                <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  {best.reasons.map((r) => (
                    <span key={r} className="chip chip-wrap">
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="banner" style={{ alignItems: 'flex-start' }}>
              None of your cards is a clean fit here — check the blockers below before you pay.
            </div>
          )}

          <div style={{ overflowX: 'auto', marginTop: 14 }}>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Card</th>
                    <th>Rate</th>
                    <th className="num">Rewards</th>
                    <th className="num">Bonus boost</th>
                    <th className="num">Credit</th>
                    <th className="num">Total</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {advice.options.map((o) => {
                    const blocked = o.blockers.length > 0;
                    return (
                      <tr key={o.account.id} style={blocked ? { opacity: 0.55 } : undefined}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{o.account.name}</div>
                          <div className="small muted">•••• {o.account.mask}</div>
                        </td>
                        <td className="tnum">{rateLabel(o.product, o.multiplier)}</td>
                        <td className="num">{fmtCents(o.rewardValueCents)}</td>
                        <td className="num">{o.bonusBoostCents > 0 ? fmtCents(o.bonusBoostCents) : '—'}</td>
                        <td className="num">{o.creditValueCents > 0 ? fmtCents(o.creditValueCents) : '—'}</td>
                        <td className="num" style={{ fontWeight: 650 }}>
                          {fmtCents(o.totalValueCents)}
                        </td>
                        <td>
                          {blocked ? (
                            <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                              {o.blockers.map((b) => (
                                <span key={b} className="badge badge-bad">
                                  {b}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="small muted">{o.reasons.slice(0, 2).join(' · ')}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {advice.tips.length > 0 && (
            <ul className="small" style={{ margin: '12px 0 0', paddingLeft: 18, color: 'var(--ink-2)' }}>
              {advice.tips.map((t) => (
                <li key={t} style={{ marginTop: 4 }}>
                  {t}
                </li>
              ))}
            </ul>
          )}

          <Disclaimer />
        </div>
      ) : null}
    </div>
  );
}
