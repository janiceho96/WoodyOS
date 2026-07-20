import { query } from '../db/client.js';
import type { AiProviderName } from './ai-provider.js';
import { estimateClaudeCostUsd } from './pricing.js';

type HeaderReader = { get(name: string): string | null };

export type ProviderQuotaSnapshot = {
  requestLimit: number | null;
  requestsRemaining: number | null;
  requestsResetAt: Date | null;
  tokenLimit: number | null;
  tokensRemaining: number | null;
  tokensResetAt: Date | null;
  creditRemainingUsd: number | null;
};

export type WorkspaceBudget = {
  monthlyRequestLimit: number | null;
  monthlyTokenLimit: number | null;
  monthlyCostLimitUsd: number | null;
  inputCostPerMillionUsd: number | null;
  outputCostPerMillionUsd: number | null;
  warningPercent: number;
  hardLimit: boolean;
};

const integer = (value: string | null) => {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};

const decimal = (value: string | null) => {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

function first(headers: HeaderReader, names: string[]) {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null && value !== '') return value;
  }
  return null;
}

export function parseProviderReset(value: string | null, now = new Date()) {
  if (!value) return null;
  const absolute = Date.parse(value);
  if (!Number.isNaN(absolute)) return new Date(absolute);
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const numeric = Number(value);
    return new Date(numeric > 10_000_000_000 ? numeric : numeric > 1_000_000_000 ? numeric * 1000 : now.getTime() + numeric * 1000);
  }
  const units = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi)];
  if (!units.length) return null;
  const multipliers: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const duration = units.reduce((total, match) => total + Number(match[1]) * multipliers[match[2].toLowerCase()], 0);
  return new Date(now.getTime() + duration);
}

export function providerQuotaFromHeaders(headers: HeaderReader): ProviderQuotaSnapshot | null {
  const snapshot: ProviderQuotaSnapshot = {
    requestLimit: integer(first(headers, ['anthropic-ratelimit-requests-limit', 'x-ratelimit-limit-requests', 'ratelimit-limit'])),
    requestsRemaining: integer(first(headers, ['anthropic-ratelimit-requests-remaining', 'x-ratelimit-remaining-requests', 'ratelimit-remaining'])),
    requestsResetAt: parseProviderReset(first(headers, ['anthropic-ratelimit-requests-reset', 'x-ratelimit-reset-requests', 'ratelimit-reset'])),
    tokenLimit: integer(first(headers, ['anthropic-ratelimit-tokens-limit', 'x-ratelimit-limit-tokens'])),
    tokensRemaining: integer(first(headers, ['anthropic-ratelimit-tokens-remaining', 'x-ratelimit-remaining-tokens'])),
    tokensResetAt: parseProviderReset(first(headers, ['anthropic-ratelimit-tokens-reset', 'x-ratelimit-reset-tokens'])),
    creditRemainingUsd: decimal(first(headers, ['x-credits-remaining-usd', 'x-credit-remaining-usd', 'x-balance-usd'])),
  };
  return Object.values(snapshot).some((value) => value !== null) ? snapshot : null;
}

async function budgetRow(workspaceId: string) {
  return (await query<{
    monthly_request_limit: string | null;
    monthly_token_limit: string | null;
    monthly_cost_limit_usd: string | null;
    input_cost_per_million_usd: string | null;
    output_cost_per_million_usd: string | null;
    warning_percent: number;
    hard_limit: boolean;
  }>(
    `SELECT monthly_request_limit::text,monthly_token_limit::text,monthly_cost_limit_usd::text,
      input_cost_per_million_usd::text,output_cost_per_million_usd::text,warning_percent,hard_limit
     FROM workspace_ai_budgets WHERE workspace_id=$1`,
    [workspaceId],
  )).rows[0];
}

function normalizedBudget(row: Awaited<ReturnType<typeof budgetRow>>): WorkspaceBudget {
  return {
    monthlyRequestLimit: row?.monthly_request_limit === null || row?.monthly_request_limit === undefined ? null : Number(row.monthly_request_limit),
    monthlyTokenLimit: row?.monthly_token_limit === null || row?.monthly_token_limit === undefined ? null : Number(row.monthly_token_limit),
    monthlyCostLimitUsd: row?.monthly_cost_limit_usd === null || row?.monthly_cost_limit_usd === undefined ? null : Number(row.monthly_cost_limit_usd),
    inputCostPerMillionUsd: row?.input_cost_per_million_usd === null || row?.input_cost_per_million_usd === undefined ? null : Number(row.input_cost_per_million_usd),
    outputCostPerMillionUsd: row?.output_cost_per_million_usd === null || row?.output_cost_per_million_usd === undefined ? null : Number(row.output_cost_per_million_usd),
    warningPercent: row?.warning_percent ?? 80,
    hardLimit: row?.hard_limit ?? false,
  };
}

export async function estimatedWorkspaceAiCost(workspaceId: string, model: string, inputTokens: number, outputTokens: number) {
  const budget = normalizedBudget(await budgetRow(workspaceId));
  if (budget.inputCostPerMillionUsd !== null && budget.outputCostPerMillionUsd !== null) {
    return Number((
      inputTokens / 1_000_000 * budget.inputCostPerMillionUsd
      + outputTokens / 1_000_000 * budget.outputCostPerMillionUsd
    ).toFixed(6));
  }
  return estimateClaudeCostUsd(model, inputTokens, outputTokens);
}

export async function recordAiUsage(input: {
  workspaceId: string;
  taskId?: string | null;
  workflowRunId?: string | null;
  source: 'task' | 'prompt_compiler' | 'copilot';
  provider: AiProviderName;
  model: string;
  requestId?: string | null;
  inputTokens: number;
  outputTokens: number;
  headers?: HeaderReader | null;
}) {
  const estimatedCostUsd = await estimatedWorkspaceAiCost(input.workspaceId, input.model, input.inputTokens, input.outputTokens);
  await query(
    `INSERT INTO ai_usage_events(
       workspace_id,task_id,workflow_run_id,source,provider,model,request_id,input_tokens,output_tokens,estimated_cost_usd
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT(workspace_id,provider,request_id) WHERE request_id IS NOT NULL DO NOTHING`,
    [
      input.workspaceId, input.taskId ?? null, input.workflowRunId ?? null, input.source, input.provider,
      input.model, input.requestId ?? null, input.inputTokens, input.outputTokens, estimatedCostUsd,
    ],
  );
  const quota = input.headers ? providerQuotaFromHeaders(input.headers) : null;
  if (quota) {
    await query(
      `INSERT INTO ai_provider_quota_snapshots(
         workspace_id,provider,model,request_id,request_limit,requests_remaining,requests_reset_at,
         token_limit,tokens_remaining,tokens_reset_at,credit_remaining_usd
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.workspaceId, input.provider, input.model, input.requestId ?? null,
        quota.requestLimit, quota.requestsRemaining, quota.requestsResetAt,
        quota.tokenLimit, quota.tokensRemaining, quota.tokensResetAt, quota.creditRemainingUsd,
      ],
    );
  }
  return estimatedCostUsd;
}

const percentage = (used: number, limit: number | null) => limit ? used / limit * 100 : null;

export async function workspaceAiQuotaStatus(workspaceId: string) {
  const [row, usage, latest] = await Promise.all([
    budgetRow(workspaceId),
    query<{
      requests_used: string;
      input_tokens: string;
      output_tokens: string;
      estimated_cost_usd: string;
      tracked_since: Date | null;
      period_start: Date;
      period_end: Date;
    }>(
      `SELECT count(*)::text requests_used,coalesce(sum(input_tokens),0)::text input_tokens,
       coalesce(sum(output_tokens),0)::text output_tokens,coalesce(sum(estimated_cost_usd),0)::text estimated_cost_usd,
       min(created_at) tracked_since,date_trunc('month',now()) period_start,
       date_trunc('month',now()) + interval '1 month' period_end
       FROM ai_usage_events WHERE workspace_id=$1 AND created_at >= date_trunc('month',now())`,
      [workspaceId],
    ),
    query<{
      provider: string;
      model: string;
      request_id: string | null;
      request_limit: string | null;
      requests_remaining: string | null;
      requests_reset_at: Date | null;
      token_limit: string | null;
      tokens_remaining: string | null;
      tokens_reset_at: Date | null;
      credit_remaining_usd: string | null;
      captured_at: Date;
    }>(
      `SELECT provider,model,request_id,request_limit::text,requests_remaining::text,requests_reset_at,
       token_limit::text,tokens_remaining::text,tokens_reset_at,credit_remaining_usd::text,captured_at
       FROM ai_provider_quota_snapshots WHERE workspace_id=$1 ORDER BY captured_at DESC LIMIT 1`,
      [workspaceId],
    ),
  ]);
  const budget = normalizedBudget(row);
  const current = usage.rows[0];
  const requestsUsed = Number(current.requests_used);
  const inputTokens = Number(current.input_tokens);
  const outputTokens = Number(current.output_tokens);
  const tokensUsed = inputTokens + outputTokens;
  const costUsedUsd = Number(current.estimated_cost_usd);
  const percentages = {
    requests: percentage(requestsUsed, budget.monthlyRequestLimit),
    tokens: percentage(tokensUsed, budget.monthlyTokenLimit),
    cost: percentage(costUsedUsd, budget.monthlyCostLimitUsd),
  };
  const maximumPercent = Math.max(0, ...Object.values(percentages).filter((value): value is number => value !== null));
  const configured = budget.monthlyRequestLimit !== null || budget.monthlyTokenLimit !== null || budget.monthlyCostLimitUsd !== null;
  const blocked = Boolean(budget.hardLimit && configured && maximumPercent >= 100);
  const state = blocked ? 'blocked' : configured && maximumPercent >= budget.warningPercent ? 'warning' : configured ? 'healthy' : 'unconfigured';
  const provider = latest.rows[0];
  return {
    state,
    blocked,
    budget,
    usage: { requestsUsed, inputTokens, outputTokens, tokensUsed, costUsedUsd },
    percentages,
    maximumPercent,
    period: { start: current.period_start, end: current.period_end, trackedSince: current.tracked_since },
    provider: provider ? {
      name: provider.provider,
      model: provider.model,
      requestId: provider.request_id,
      requestLimit: provider.request_limit === null ? null : Number(provider.request_limit),
      requestsRemaining: provider.requests_remaining === null ? null : Number(provider.requests_remaining),
      requestsResetAt: provider.requests_reset_at,
      tokenLimit: provider.token_limit === null ? null : Number(provider.token_limit),
      tokensRemaining: provider.tokens_remaining === null ? null : Number(provider.tokens_remaining),
      tokensResetAt: provider.tokens_reset_at,
      creditRemainingUsd: provider.credit_remaining_usd === null ? null : Number(provider.credit_remaining_usd),
      capturedAt: provider.captured_at,
    } : null,
  };
}

export async function assertWorkspaceAiBudgetAvailable(workspaceId: string) {
  const status = await workspaceAiQuotaStatus(workspaceId);
  if (status.blocked) throw Object.assign(new Error('AI_BUDGET_EXHAUSTED'), { statusCode: 429, code: 'AI_BUDGET_EXHAUSTED' });
  return status;
}
