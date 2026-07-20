import { type ReactNode, useEffect } from 'react';
import { AlertTriangle, Boxes, CheckCircle2, X } from 'lucide-react';

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-header">
    <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1><p>{description}</p></div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>;
}

export function Status({ value }: { value: string }) {
  const normalized = value === 'paused' || value === 'draft' ? 'idle' : value;
  return <span className={`status-badge ${normalized}`}><i/>{normalized.replaceAll('_', ' ')}</span>;
}

export function EmptyState({ Icon = Boxes, title, text, action }: { Icon?: typeof Boxes; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><span><Icon size={23}/></span><strong>{title}</strong><p>{text}</p>{action}</div>;
}

export function Notice({ text, error = false, dismiss }: { text: string; error?: boolean; dismiss: () => void }) {
  if (!text) return null;
  return <div className={`toast ${error ? 'error' : ''}`} role="status">
    {error ? <AlertTriangle size={16}/> : <CheckCircle2 size={16}/>}<span>{text}</span>
    <button className="icon-button" onClick={dismiss} aria-label="Dismiss"><X size={15}/></button>
  </div>;
}

export function Modal({ title, close, children, wide = false }: { title: string; close: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [close]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-head"><div><span className="eyebrow">Woody</span><h2>{title}</h2></div><button className="icon-button" onClick={close} aria-label="Close dialog"><X size={18}/></button></div>{children}
    </section>
  </div>;
}
