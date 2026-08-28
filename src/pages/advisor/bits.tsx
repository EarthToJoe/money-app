import type { ReactNode } from 'react';
import type { CardProduct } from '../../types';

/** The compliance line that must accompany every recommendation. */
export function Disclaimer() {
  return (
    <p className="small muted" style={{ marginTop: 14 }}>
      Not financial advice — verify terms with the issuer.
    </p>
  );
}

/** A .chip rendered as a clickable button (quick picks, recent lookups, example prompts). */
export function ChipButton({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="chip"
      onClick={onClick}
      title={title}
      style={{ border: 0, cursor: 'pointer' }}
    >
      {children}
    </button>
  );
}

/** "1.5" not "1.50". */
export function trimNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** "4x" for points/miles cards, "2%" for cash back. */
export function rateLabel(product: CardProduct, multiplier: number): string {
  return product.currency === 'cashback' ? `${trimNum(multiplier)}%` : `${trimNum(multiplier)}x`;
}
