import { assertConfiguredAiProvider, configuredAiProviderForWorkspace } from '../lib/ai-provider.js';
import { assertWorkspaceAiBudgetAvailable, recordAiUsage } from '../lib/ai-usage.js';
import { containsLikelySecret } from '../solutions/compiler.js';

export type CopilotCompletionMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export async function requestCopilotCompletion(input: {
  workspaceId: string;
  messages: CopilotCompletionMessage[];
  system: string;
  maxTokens?: number;
}) {
  const latest = input.messages.at(-1)?.content ?? '';
  if (containsLikelySecret(latest)) {
    throw Object.assign(new Error('MESSAGE_CONTAINS_POSSIBLE_SECRET'), { statusCode: 400 });
  }
  await assertWorkspaceAiBudgetAvailable(input.workspaceId);
  const runtime = assertConfiguredAiProvider(await configuredAiProviderForWorkspace(input.workspaceId));
  const model = runtime.defaultModel;
  let message = '';
  let requestId: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let headers: { get(name: string): string | null } | null = null;

  if (runtime.anthropic) {
    const result = await runtime.anthropic.messages.create({
      model,
      system: input.system,
      max_tokens: input.maxTokens ?? 1_500,
      temperature: 0.3,
      messages: input.messages,
    }).withResponse();
    message = result.data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    requestId = result.request_id ?? null;
    inputTokens = result.data.usage.input_tokens;
    outputTokens = result.data.usage.output_tokens;
    headers = result.response.headers;
  } else if (runtime.openAiCompatible) {
    const result = await runtime.openAiCompatible.chat.completions.create({
      model,
      temperature: 0.3,
      max_tokens: input.maxTokens ?? 1_500,
      messages: [{ role: 'system', content: input.system }, ...input.messages],
    }).withResponse();
    message = result.data.choices[0]?.message?.content ?? '';
    requestId = result.request_id;
    inputTokens = result.data.usage?.prompt_tokens ?? 0;
    outputTokens = result.data.usage?.completion_tokens ?? 0;
    headers = result.response.headers;
  }
  if (!message.trim()) {
    throw Object.assign(new Error('COPILOT_EMPTY_RESPONSE'), { statusCode: 502 });
  }

  const estimatedCostUsd = await recordAiUsage({
    workspaceId: input.workspaceId,
    source: 'copilot',
    provider: runtime.provider,
    model,
    requestId,
    inputTokens,
    outputTokens,
    headers,
  });
  return {
    message,
    provider: runtime.provider,
    model,
    usage: { inputTokens, outputTokens, estimatedCostUsd },
  };
}
