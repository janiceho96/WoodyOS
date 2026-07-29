import { z } from 'zod';
import { agentAvatarSchema } from './avatar.js';

const defaultModel = process.env.LLM_DEFAULT_MODEL ?? 'claude-sonnet-4-20250514';

export const agentModelConfigSchema = z.object({
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(128).max(128_000).default(4096),
  topP: z.number().min(0).max(1).default(1),
});

export const agentCapabilitiesSchema = z.object({
  webBrowser: z.boolean().default(false),
  codeInterpreter: z.boolean().default(false),
  knowledgeBase: z.boolean().default(true),
});

export const agentInputSchema = z.object({
  name: z.string().min(2).max(120),
  role: z.string().min(2).max(240),
  goal: z.string().min(2).max(5000),
  instructions: z.string().max(20000).default(''),
  personality: z.string().max(80).nullable().optional(),
  model: z.string().min(2).max(160).default(defaultModel),
  modelConfig: agentModelConfigSchema.default({ temperature: 0.2, maxTokens: 4096, topP: 1 }),
  capabilities: agentCapabilitiesSchema.default({ webBrowser: false, codeInterpreter: false, knowledgeBase: true }),
  status: z.enum(['draft', 'active', 'paused', 'archived']).default('draft'),
  toolIds: z.array(z.string().uuid()).default([]),
  memoryConfig: z.record(z.boolean()).default({ shortTerm: true, longTerm: true, knowledgeBase: true }),
  avatar: agentAvatarSchema.optional(),
});

export type AgentInput = z.infer<typeof agentInputSchema>;

export type AgentRecord = {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
  goal: string;
  instructions: string;
  personality: string | null;
  model: string;
  model_config: AgentInput['modelConfig'];
  capabilities: AgentInput['capabilities'];
  status: AgentInput['status'];
  tool_ids: string[];
  memory_config: Record<string, boolean>;
  avatar_config: Record<string, unknown>;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};
