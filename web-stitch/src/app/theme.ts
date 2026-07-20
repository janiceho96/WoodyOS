import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

function initialTheme(): Theme {
  const stored = localStorage.getItem('nexus_stitch_theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem('nexus_stitch_theme', theme);
  }, [theme]);
  return { theme, setTheme, toggleTheme: () => setTheme((current) => current === 'dark' ? 'light' : 'dark') };
}
