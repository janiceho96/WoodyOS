import { memo, type CSSProperties } from 'react';

export type AppBrandMarkProps = {
  appId?: string | null;
  title: string;
  color?: string | null;
  size?: 'small' | 'medium' | 'large';
};

const aliases: Array<[string, string]> = [
  ['notion', 'notion'], ['github', 'github'], ['linear', 'linear'], ['stripe', 'stripe'],
  ['figma', 'figma'], ['google drive', 'google-drive'], ['gmail', 'gmail'],
  ['google calendar', 'google-calendar'], ['calendar', 'google-calendar'], ['obsidian', 'obsidian'],
];

function appIdFromTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  return aliases.find(([needle]) => normalized.includes(needle))?.[1] ?? null;
}

export const AppBrandMark = memo(function AppBrandMark({ appId, title, color, size = 'medium' }: AppBrandMarkProps) {
  const id = appId ?? appIdFromTitle(title);
  const style = { '--app-brand': color ?? defaultColor(id) } as CSSProperties;
  return <span className={`app-brand-mark ${size} ${id ?? 'custom'}`} style={style} aria-hidden="true">
    {id === 'github' ? <svg viewBox="0 0 24 24"><path d="M12 3a8.8 8.8 0 0 0-2.8 17.1c.4.1.5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-1-.9-1.3-.9-1.3-.8-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.7.9 2.1.7.1-.5.3-.9.6-1.1-1.8-.2-3.6-.9-3.6-3.9 0-.9.3-1.6.8-2.2-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.3.8A7.8 7.8 0 0 1 12 7c.7 0 1.4.1 2.1.3 1.6-1 2.3-.8 2.3-.8.5 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.2 0 3-1.8 3.7-3.6 3.9.3.3.6.8.6 1.5v3.5c0 .3.1.5.6.4A8.8 8.8 0 0 0 12 3Z"/></svg>
      : id === 'figma' ? <svg viewBox="0 0 24 24"><circle cx="8" cy="5" r="3"/><circle cx="14" cy="5" r="3"/><circle cx="8" cy="11" r="3"/><circle cx="14" cy="11" r="3"/><circle cx="8" cy="17" r="3"/></svg>
        : id === 'gmail' ? <svg viewBox="0 0 24 24"><path d="M3 7.5 12 14l9-6.5v10.8c0 .9-.7 1.7-1.7 1.7H4.7c-.9 0-1.7-.7-1.7-1.7V7.5Z" fill="none"/><path d="m3 7.5 9 6.5 9-6.5" fill="none"/></svg>
          : id === 'google-drive' ? <svg viewBox="0 0 24 24"><path d="m9 3 4 7-5 9H3l5-9h5l-4-7Z"/><path d="m9 3 4 7h8l-4-7H9Z" opacity=".75"/><path d="m8 19 5-9h8l-5 9H8Z" opacity=".55"/></svg>
            : id === 'google-calendar' ? <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2" fill="none"/><path d="M3 9h18"/><text x="12" y="17" textAnchor="middle">31</text></svg>
              : id === 'linear' ? <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none"/><path d="M5.5 9.2 14.8 18M5 13l5.8 5.5M8 5.8l10.2 9.8" fill="none"/></svg>
                : id === 'obsidian' ? <svg viewBox="0 0 24 24"><path d="m12 2 7 6-2 11-5 3-6-4L5 8l7-6Z" fill="none"/><path d="m5 8 7 4 7-4M12 12v10" fill="none"/></svg>
                  : <strong>{id === 'notion' ? 'N' : id === 'stripe' ? 'S' : title.slice(0, 1).toUpperCase()}</strong>}
  </span>;
});

function defaultColor(id: string | null) {
  if (id === 'github') return '#8b949e';
  if (id === 'linear') return '#7c6df2';
  if (id === 'stripe') return '#635bff';
  if (id === 'figma') return '#f24e1e';
  if (id === 'google-drive') return '#0f9d58';
  if (id === 'gmail') return '#ea4335';
  if (id === 'google-calendar') return '#4285f4';
  if (id === 'obsidian') return '#7c3aed';
  return '#aaaaff';
}
