import { z } from 'zod';

export const agentAvatarIconSchema = z.enum([
  'agent', 'network', 'search', 'route', 'code', 'pen', 'megaphone', 'chart', 'check',
  'brain', 'zap', 'users', 'coins', 'palette', 'shield', 'sparkles',
]);

export const agentAvatarBrandSchema = z.enum([
  'anthropic', 'brave', 'claude', 'deepseek', 'figma', 'firecrawl', 'gemini',
  'github', 'gmail', 'google', 'google-drive', 'groq', 'linear', 'mcp', 'mistral',
  'notion', 'obsidian', 'ollama', 'openai', 'openrouter', 'qwen', 'reddit',
  'searxng', 'siliconcloud', 'stripe', 'tavily',
]);

const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex color');

export const agentAvatarSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('icon'),
    value: agentAvatarIconSchema,
    backgroundColor: colorSchema.optional(),
    accentColor: colorSchema.optional(),
    alt: z.string().trim().max(160).optional(),
  }),
  z.object({
    type: z.literal('brand'),
    value: agentAvatarBrandSchema,
    backgroundColor: colorSchema.optional(),
    accentColor: colorSchema.optional(),
    alt: z.string().trim().max(160).optional(),
  }),
  z.object({
    type: z.literal('initials'),
    value: z.string().trim().min(1).max(3),
    backgroundColor: colorSchema.optional(),
    accentColor: colorSchema.optional(),
    alt: z.string().trim().max(160).optional(),
  }),
  z.object({
    type: z.literal('image'),
    value: z.literal('uploaded'),
    alt: z.string().trim().max(160).optional(),
  }),
]);

export type AgentAvatarConfig = z.infer<typeof agentAvatarSchema>;
