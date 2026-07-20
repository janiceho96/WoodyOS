import { z } from 'zod';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const presentationStyleSchema = z.enum(['premium-dark', 'minimal-light', 'strategy-dashboard', 'investor-pitch', 'research-report']);
export const presentationThemeSchema = z.object({
  style: presentationStyleSchema.default('premium-dark'),
  background: hex.default('#0B1020'), surface: hex.default('#121A30'), primary: hex.default('#7C5CFF'),
  accent: hex.default('#4DE1FF'), success: hex.default('#4EE3A3'), text: hex.default('#F5F7FF'), muted: hex.default('#AAB3CC'),
  headingFont: z.string().min(1).max(80).default('Aptos Display'), bodyFont: z.string().min(1).max(80).default('Aptos'),
  visualDirection: z.string().max(600).default('Premium dark presentation with generous whitespace, subtle cards, and a clear visual hierarchy.'),
  maxWordsPerSlide: z.number().int().min(15).max(80).default(35),
});
export type PresentationTheme = z.infer<typeof presentationThemeSchema>;

const defaults: PresentationTheme = presentationThemeSchema.parse({});
const styleDefaults: Record<PresentationTheme['style'], Partial<PresentationTheme>> = {
  'premium-dark': {},
  'minimal-light': { background: '#FAFAFC', surface: '#FFFFFF', primary: '#4338CA', accent: '#0284C7', success: '#059669', text: '#151827', muted: '#5F6678', headingFont: 'Aptos Display', bodyFont: 'Aptos' },
  'strategy-dashboard': { background: '#0A1020', surface: '#111C34', primary: '#6366F1', accent: '#22D3EE', success: '#34D399', text: '#F8FAFC', muted: '#A7B2CC' },
  'investor-pitch': { background: '#140B2D', surface: '#211242', primary: '#A78BFA', accent: '#F9A8D4', success: '#6EE7B7', text: '#FFF7ED', muted: '#D8CDEB' },
  'research-report': { background: '#F7F8FC', surface: '#FFFFFF', primary: '#1D4ED8', accent: '#0F766E', success: '#047857', text: '#14213D', muted: '#52627E' },
};
const colorNames: Record<keyof Pick<PresentationTheme, 'background' | 'surface' | 'primary' | 'accent' | 'success' | 'text' | 'muted'>, RegExp> = {
  background: /(?:background|canvas)\s*:\s*(#[0-9a-f]{6})/i,
  surface: /(?:surface|panel|card)\s*:\s*(#[0-9a-f]{6})/i,
  primary: /(?:primary|indigo|brand)\s*:\s*(#[0-9a-f]{6})/i,
  accent: /(?:accent|cyan)\s*:\s*(#[0-9a-f]{6})/i,
  success: /(?:success|emerald)\s*:\s*(#[0-9a-f]{6})/i,
  text: /(?:primary text|text)\s*:\s*(#[0-9a-f]{6})/i,
  muted: /(?:secondary text|muted)\s*:\s*(#[0-9a-f]{6})/i,
};

function capture(markdown: string, expression: RegExp, fallback: string) {
  return expression.exec(markdown)?.[1] ?? fallback;
}

export function themeFromDesignMarkdown(designMarkdown: string): PresentationTheme {
  const requestedStyle = capture(designMarkdown, /(?:deck\s+)?style\s*:\s*([^\n]+)/i, defaults.style).toLowerCase().trim().replace(/[ _]+/g, '-');
  const styleAliases: Record<string, PresentationTheme['style']> = { editorial: 'minimal-light', minimal: 'minimal-light', keynote: 'minimal-light', dashboard: 'strategy-dashboard', strategy: 'strategy-dashboard', pitch: 'investor-pitch', investor: 'investor-pitch', research: 'research-report', report: 'research-report' };
  const style = presentationStyleSchema.safeParse(styleAliases[requestedStyle] ?? requestedStyle).success
    ? (styleAliases[requestedStyle] ?? requestedStyle) as PresentationTheme['style']
    : defaults.style;
  const styled = { ...defaults, ...styleDefaults[style] } as PresentationTheme;
  const colors = Object.fromEntries(Object.entries(colorNames).map(([key, expression]) => [key, capture(designMarkdown, expression, styled[key as keyof typeof colorNames])])) as Partial<PresentationTheme>;
  const headingFont = capture(designMarkdown, /(?:headings?|title font)\s*:\s*([^\n,]+)/i, styled.headingFont).trim();
  const bodyFont = capture(designMarkdown, /(?:body|paragraph) font\s*:\s*([^\n,]+)/i, styled.bodyFont).trim();
  const maxWords = Number(capture(designMarkdown, /maximum\s+(\d+)\s+words?\s+on\s+(?:a\s+)?(?:normal\s+)?(?:content\s+)?slide/i, String(defaults.maxWordsPerSlide)));
  const visualDirection = capture(designMarkdown, /##\s*Visual direction\s*\n([\s\S]*?)(?=\n##|$)/i, defaults.visualDirection).replace(/[-*#]/g, ' ').replace(/\s+/g, ' ').trim();
  return presentationThemeSchema.parse({ ...styled, ...colors, style, headingFont, bodyFont, visualDirection, maxWordsPerSlide: Number.isFinite(maxWords) ? maxWords : styled.maxWordsPerSlide });
}
