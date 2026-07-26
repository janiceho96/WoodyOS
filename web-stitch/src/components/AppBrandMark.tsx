import { memo, type CSSProperties } from 'react';
import { BrandIcon, brandIconKeyFor } from './BrandIcon';

export type AppBrandMarkProps = {
  appId?: string | null;
  title: string;
  color?: string | null;
  size?: 'small' | 'medium' | 'large';
};

export const AppBrandMark = memo(function AppBrandMark({ appId, title, color, size = 'medium' }: AppBrandMarkProps) {
  const id = brandIconKeyFor(appId, title);
  const style = { '--app-brand': color ?? defaultColor(id) } as CSSProperties;
  return <span className={`app-brand-mark ${size} ${id ?? 'custom'}`} style={style} aria-hidden="true">
    {id ? <BrandIcon iconKey={id} size="62%"/> : <strong>{title.slice(0, 1).toUpperCase()}</strong>}
  </span>;
});

function defaultColor(id: ReturnType<typeof brandIconKeyFor>) {
  if (id === 'github') return '#8b949e';
  if (id === 'gmail') return '#ea4335';
  if (id === 'figma') return '#f24e1e';
  if (id === 'google') return '#4285f4';
  if (id === 'google-drive') return '#0f9d58';
  if (id === 'linear') return '#7c6df2';
  if (id === 'obsidian') return '#7c3aed';
  if (id === 'reddit') return '#ff4500';
  if (id === 'stripe') return '#635bff';
  if (id === 'firecrawl') return '#ff4d00';
  if (id === 'brave') return '#ff4000';
  if (id === 'mcp') return '#aaaaff';
  return '#aaaaff';
}
