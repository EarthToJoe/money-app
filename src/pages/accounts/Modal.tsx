import { useEffect, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** Override the default 620px max width. */
  maxWidth?: number;
}

/** Overlay + .modal shell shared by the Accounts page dialogs. Closes on Escape or backdrop click. */
export function Modal({ title, subtitle, onClose, children, maxWidth }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={maxWidth ? { maxWidth } : undefined}>
        <div className="spread" style={{ alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</h2>
            {subtitle && <p className="small muted" style={{ marginTop: 2 }}>{subtitle}</p>}
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: '4px 9px', marginTop: -4 }}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
