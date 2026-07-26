import { z } from 'zod';

export const agentOutputContractSchema = z.enum(['text', 'grader']);
export type AgentOutputContract = z.infer<typeof agentOutputContractSchema>;

export const graderOutputSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  feedback: z.array(z.string().trim().min(1).max(2_000)).max(50),
  criteria: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    score: z.number().min(0).max(100),
    reason: z.string().trim().min(1).max(2_000),
  })).max(50).default([]),
});

export function outputContractFromTaskInput(input: Record<string, unknown>): AgentOutputContract {
  const workflow = input.workflow;
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return 'text';
  const parsed = agentOutputContractSchema.safeParse((workflow as Record<string, unknown>).outputContract);
  return parsed.success ? parsed.data : 'text';
}

export function outputContractInstruction(contract: AgentOutputContract) {
  if (contract !== 'grader') return '';
  return 'Return one JSON object only with this exact contract: {"passed":boolean,"score":number from 0 to 100,"feedback":string[],"criteria":[{"name":string,"score":number from 0 to 100,"reason":string}]}. Do not wrap it in Markdown.';
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  return JSON.parse(fenced ?? trimmed) as unknown;
}

export function parseAgentOutput(text: string, contract: AgentOutputContract, toolCallCount: number) {
  const clean = text.trim();
  if (contract !== 'grader') return { text: clean, toolCallCount };
  try {
    const data = graderOutputSchema.parse(parseJsonObject(clean));
    return { text: clean, data, toolCallCount };
  } catch {
    throw Object.assign(new Error('Agent grader output did not match its contract'), { retryable: true });
  }
}
