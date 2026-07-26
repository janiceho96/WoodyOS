export type HtmlArtifactTheme = {
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  headingFont: 'system' | 'serif' | 'mono';
  bodyFont: 'system' | 'serif' | 'mono';
  density: 'comfortable' | 'compact';
};

const defaults: HtmlArtifactTheme = {
  background: '#0B1020',
  surface: '#121A30',
  text: '#F5F7FF',
  muted: '#AAB3CC',
  accent: '#8B7CFF',
  border: '#2B3657',
  headingFont: 'system',
  bodyFont: 'system',
  density: 'comfortable',
};

function field(markdown: string, labels: string[]) {
  for (const label of labels) {
    const match = markdown.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${label}\\s*:\\s*([^\\n]+)`, 'i'));
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function color(markdown: string, labels: string[], fallback: string) {
  const match = field(markdown, labels).match(/#[0-9a-f]{6}\b/i);
  return match?.[0].toUpperCase() ?? fallback;
}

function font(markdown: string, labels: string[]): HtmlArtifactTheme['headingFont'] {
  const value = field(markdown, labels).toLowerCase();
  if (/\b(serif|georgia|times)\b/.test(value)) return 'serif';
  if (/\b(mono|jetbrains|consolas|courier)\b/.test(value)) return 'mono';
  return 'system';
}

export function htmlThemeFromDesignMarkdown(markdown: string): HtmlArtifactTheme {
  return {
    background: color(markdown, ['Background'], defaults.background),
    surface: color(markdown, ['Surface', 'Card'], defaults.surface),
    text: color(markdown, ['Primary text', 'Text'], defaults.text),
    muted: color(markdown, ['Secondary text', 'Muted'], defaults.muted),
    accent: color(markdown, ['Accent', 'Primary'], defaults.accent),
    border: color(markdown, ['Border', 'Line'], defaults.border),
    headingFont: font(markdown, ['Headings', 'Heading font']),
    bodyFont: font(markdown, ['Body font', 'Body']),
    density: /\bcompact\b/i.test(field(markdown, ['Density', 'Spacing'])) ? 'compact' : 'comfortable',
  };
}
