import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';

export function DepartmentDrawer({
  title,
  eyebrow,
  close,
  suspended = false,
  children,
}: {
  title: string;
  eyebrow: string;
  close: () => void;
  suspended?: boolean;
  children: ReactNode;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  const titleId = useId();
  closeRef.current = close;
  useEffect(() => {
    if (suspended) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusable = () => Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        drawerRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handler);
    const frame = window.requestAnimationFrame(() => (
      focusable()[0] ?? drawerRef.current
    )?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handler);
      previousFocus?.focus();
    };
  }, [suspended]);
  return <>
    <button
      type="button"
      className="department-drawer-backdrop"
      onClick={suspended ? undefined : close}
      aria-label="Close Department drawer"
    />
    <aside
      ref={drawerRef}
      className="department-drawer"
      tabIndex={-1}
      role="dialog"
      aria-modal={!suspended}
      aria-labelledby={titleId}
    >
      <header>
        <div><span className="eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2></div>
        <button type="button" className="icon-button" onClick={close} aria-label="Close drawer"><X size={18}/></button>
      </header>
      <div className="department-drawer-body">{children}</div>
    </aside>
  </>;
}
