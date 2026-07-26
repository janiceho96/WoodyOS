import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
export const DEFAULT_ACCENT_COLOR = '#8083ff';

function isHexColor(value: string | null): value is string {
  return Boolean(value && /^#[0-9a-f]{6}$/i.test(value));
}

function contrastInk(color: string) {
  const channels = color.slice(1).match(/.{2}/g)?.map((value) => Number.parseInt(value, 16) / 255) ?? [0, 0, 0];
  const luminance = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  return luminance > 0.22 ? '#111218' : '#ffffff';
}

function initialTheme(): Theme {
  const stored = localStorage.getItem('nexus_stitch_theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [accentColor, setAccentColor] = useState(() => {
    const stored = localStorage.getItem('nexus_stitch_accent');
    return isHexColor(stored) ? stored : DEFAULT_ACCENT_COLOR;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem('nexus_stitch_theme', theme);
  }, [theme]);
  useEffect(() => {
    const normalized = isHexColor(accentColor) ? accentColor.toLowerCase() : DEFAULT_ACCENT_COLOR;
    document.documentElement.style.setProperty('--app-accent', normalized);
    document.documentElement.style.setProperty('--primary-ink', contrastInk(normalized));
    localStorage.setItem('nexus_stitch_accent', normalized);
  }, [accentColor]);
  return {
    theme,
    setTheme,
    toggleTheme: () => setTheme((current) => current === 'dark' ? 'light' : 'dark'),
    accentColor,
    setAccentColor,
  };
}
