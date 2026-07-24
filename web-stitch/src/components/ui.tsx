import { type ReactNode, useEffect, useId, useRef } from 'react';
import { AlertTriangle, Boxes, CheckCircle2, X } from 'lucide-react';

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-header">
    <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1><p>{description}</p></div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>;
}

export function Status({ value }: { value: string }) {
  return <span className={`status-badge ${value}`}><i/>{value.replaceAll('_', ' ')}</span>;
}

export function EmptyState({ Icon = Boxes, title, text, action }: { Icon?: typeof Boxes; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><span><Icon size={23}/></span><strong>{title}</strong><p>{text}</p>{action}</div>;
}

export function Notice({ text, error = false, dismiss, action }: { text: string; error?: boolean; dismiss: () => void; action?: { label: string; onClick: () => void } }) {
  if (!text) return null;
  return <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
    {error ? <AlertTriangle size={16}/> : <CheckCircle2 size={16}/>}<span>{text}</span>
    {action && <button className="toast-action" type="button" onClick={() => { action.onClick(); dismiss(); }}>{action.label}</button>}
    <button className="icon-button" type="button" onClick={dismiss} aria-label="Dismiss"><X size={15}/></button>
  </div>;
}

export function Modal({ title, close, children, wide = false }: { title: string; close: () => void; children: ReactNode; wide?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  const titleId = useId();
  closeRef.current = close;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handler);
    const frame = window.requestAnimationFrame(() => (focusable()[0] ?? dialogRef.current)?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialogRef} tabIndex={-1} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-head"><div><span className="eyebrow">Woody</span><h2 id={titleId}>{title}</h2></div><button className="icon-button" type="button" onClick={close} aria-label="Close dialog"><X size={18}/></button></div>{children}
    </section>
  </div>;
}
