/* oxlint-disable react/only-export-components -- the validated registry and renderer intentionally share one module */
import anthropicIcon from '@lobehub/icons-static-svg/icons/anthropic.svg';
import braveIcon from '@lobehub/icons-static-svg/icons/brave-color.svg';
import claudeIcon from '@lobehub/icons-static-svg/icons/claude-color.svg';
import deepseekIcon from '@lobehub/icons-static-svg/icons/deepseek-color.svg';
import figmaIcon from '@lobehub/icons-static-svg/icons/figma-color.svg';
import firecrawlIcon from '@lobehub/icons-static-svg/icons/firecrawl-color.svg';
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg';
import githubIcon from '@lobehub/icons-static-svg/icons/github.svg';
import googleIcon from '@lobehub/icons-static-svg/icons/google-color.svg';
import groqIcon from '@lobehub/icons-static-svg/icons/groq.svg';
import mcpIcon from '@lobehub/icons-static-svg/icons/mcp.svg';
import mistralIcon from '@lobehub/icons-static-svg/icons/mistral-color.svg';
import notionIcon from '@lobehub/icons-static-svg/icons/notion.svg';
import obsidianIcon from '@lobehub/icons-static-svg/icons/obsidian-color.svg';
import ollamaIcon from '@lobehub/icons-static-svg/icons/ollama.svg';
import openaiIcon from '@lobehub/icons-static-svg/icons/openai.svg';
import openrouterIcon from '@lobehub/icons-static-svg/icons/openrouter-color.svg';
import qwenIcon from '@lobehub/icons-static-svg/icons/qwen-color.svg';
import searxngIcon from '@lobehub/icons-static-svg/icons/searxng-color.svg';
import siliconcloudIcon from '@lobehub/icons-static-svg/icons/siliconcloud-color.svg';
import tavilyIcon from '@lobehub/icons-static-svg/icons/tavily-color.svg';
import gmailIcon from '../assets/brand/gmail.svg';
import googleDriveIcon from '../assets/brand/google-drive.svg';
import linearIcon from '../assets/brand/linear.svg';
import redditIcon from '../assets/brand/reddit.svg';
import stripeIcon from '../assets/brand/stripe.svg';
import type { CSSProperties } from 'react';

export const brandIconKeys = [
  'anthropic', 'brave', 'claude', 'deepseek', 'figma', 'firecrawl', 'gemini',
  'github', 'gmail', 'google', 'google-drive', 'groq', 'linear', 'mcp', 'mistral',
  'notion', 'obsidian', 'ollama', 'openai', 'openrouter', 'qwen', 'reddit',
  'searxng', 'siliconcloud', 'stripe', 'tavily',
] as const;

export type BrandIconKey = typeof brandIconKeys[number];

type BrandAsset = { src: string; color: boolean; label: string };

const brandAssets: Record<BrandIconKey, BrandAsset> = {
  anthropic: { src: anthropicIcon, color: false, label: 'Anthropic' },
  brave: { src: braveIcon, color: true, label: 'Brave' },
  claude: { src: claudeIcon, color: true, label: 'Claude' },
  deepseek: { src: deepseekIcon, color: true, label: 'DeepSeek' },
  figma: { src: figmaIcon, color: true, label: 'Figma' },
  firecrawl: { src: firecrawlIcon, color: true, label: 'Firecrawl' },
  gemini: { src: geminiIcon, color: true, label: 'Gemini' },
  github: { src: githubIcon, color: false, label: 'GitHub' },
  gmail: { src: gmailIcon, color: false, label: 'Gmail' },
  google: { src: googleIcon, color: true, label: 'Google' },
  'google-drive': { src: googleDriveIcon, color: false, label: 'Google Drive' },
  groq: { src: groqIcon, color: false, label: 'Groq' },
  linear: { src: linearIcon, color: false, label: 'Linear' },
  mcp: { src: mcpIcon, color: false, label: 'Model Context Protocol' },
  mistral: { src: mistralIcon, color: true, label: 'Mistral' },
  notion: { src: notionIcon, color: false, label: 'Notion' },
  obsidian: { src: obsidianIcon, color: true, label: 'Obsidian' },
  ollama: { src: ollamaIcon, color: false, label: 'Ollama' },
  openai: { src: openaiIcon, color: false, label: 'OpenAI' },
  openrouter: { src: openrouterIcon, color: true, label: 'OpenRouter' },
  qwen: { src: qwenIcon, color: true, label: 'Qwen' },
  reddit: { src: redditIcon, color: false, label: 'Reddit' },
  searxng: { src: searxngIcon, color: true, label: 'SearXNG' },
  siliconcloud: { src: siliconcloudIcon, color: true, label: 'SiliconCloud' },
  stripe: { src: stripeIcon, color: false, label: 'Stripe' },
  tavily: { src: tavilyIcon, color: true, label: 'Tavily' },
};

const aliases: Array<[RegExp, BrandIconKey]> = [
  [/\bmodel[\s-]*context[\s-]*protocol\b|\bmcp\b/i, 'mcp'],
  [/\bgoogle[\s-]*drive\b/i, 'google-drive'],
  [/\bgmail\b/i, 'gmail'],
  [/\bgoogle[\s-]*calendar\b/i, 'google'],
  [/\bsilicon[\s-]*(cloud|flow)\b/i, 'siliconcloud'],
  [/\bopen[\s-]*router\b/i, 'openrouter'],
  [/\bdeep[\s-]*seek\b/i, 'deepseek'],
  [/\bfire[\s-]*crawl\b/i, 'firecrawl'],
  [/\bsearxng\b|\bsearx\b/i, 'searxng'],
  [/\banthropic\b/i, 'anthropic'],
  [/\bclaude\b/i, 'claude'],
  [/\bgemini\b/i, 'gemini'],
  [/\bgithub\b/i, 'github'],
  [/\blinear\b/i, 'linear'],
  [/\breddit\b/i, 'reddit'],
  [/\bstripe\b/i, 'stripe'],
  [/\bgoogle\b/i, 'google'],
  [/\bnotion\b/i, 'notion'],
  [/\bfigma\b/i, 'figma'],
  [/\bobsidian\b/i, 'obsidian'],
  [/\bopenai\b|\bgpt\b/i, 'openai'],
  [/\bmistral\b/i, 'mistral'],
  [/\bollama\b/i, 'ollama'],
  [/\bbrave\b/i, 'brave'],
  [/\btavily\b/i, 'tavily'],
  [/\bqwen\b/i, 'qwen'],
  [/\bgroq\b/i, 'groq'],
];

export function isBrandIconKey(value: unknown): value is BrandIconKey {
  return typeof value === 'string' && brandIconKeys.includes(value as BrandIconKey);
}

export function brandIconKeyFor(...values: Array<string | null | undefined>): BrandIconKey | null {
  const exact = values.find((value) => isBrandIconKey(value?.trim().toLowerCase()))?.trim().toLowerCase();
  if (isBrandIconKey(exact)) return exact;
  const text = values.filter(Boolean).join(' ');
  return aliases.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

export function brandIconLabel(key: BrandIconKey) {
  return brandAssets[key].label;
}

export function BrandIcon({ iconKey, size = 24, className = '', decorative = true }: {
  iconKey: BrandIconKey;
  size?: number | string;
  className?: string;
  decorative?: boolean;
}) {
  const asset = brandAssets[iconKey];
  const dimensions = { width: size, height: size };
  if (asset.color) {
    return <img className={`brand-icon brand-icon-color ${className}`.trim()} src={asset.src} alt={decorative ? '' : asset.label} aria-hidden={decorative || undefined} style={dimensions}/>;
  }
  const style = {
    ...dimensions,
    '--brand-icon-mask': `url("${asset.src}")`,
  } as CSSProperties;
  return <span className={`brand-icon brand-icon-mono ${className}`.trim()} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : asset.label} aria-hidden={decorative || undefined} style={style}/>;
}
