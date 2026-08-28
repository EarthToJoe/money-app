import type { ReactNode } from 'react';

interface CardArtProps {
  gradient: [string, string];
  name: string;
  mask?: string;
  /** Content pinned to the bottom of the tile (earnings, rate chip, ...). */
  bottom?: ReactNode;
  /** Compact variant for inline answers and recommendation tiles. */
  mini?: boolean;
}

/** Credit-card art tile: gradient background, name, masked number. */
export function CardArt({ gradient, name, mask, bottom, mini }: CardArtProps) {
  return (
    <div
      className="card-art"
      style={{
        background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})`,
        ...(mini ? { minHeight: 72, padding: '12px 14px', borderRadius: 12 } : null),
      }}
    >
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div className="card-name" style={mini ? { fontSize: 'var(--fs-sm)' } : undefined}>
          {name}
        </div>
        {mask ? <div className="card-mask">•••• {mask}</div> : null}
      </div>
      {bottom}
    </div>
  );
}
