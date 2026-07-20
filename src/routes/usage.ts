import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { workspaceAiQuotaStatus } from '../lib/ai-usage.js';
import { query } from '../db/client.js';
import { asyncRoute, parse } from '../lib/http.js';

const budgetInput = z.object({
  monthlyRequestLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  monthlyTokenLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  monthlyCostLimitUsd: z.number().positive().max(10_000_000).nullable().default(null),
  inputCostPerMillionUsd: z.number().min(0).max(1_000_000).nullable().default(null),
  outputCostPerMillionUsd: z.number().min(0).max(1_000_000).nullable().default(null),
  warningPercent: z.number().int().min(1).max(100).default(80),
  hardLimit: z.boolean().default(false),
}).refine(
  (value) => (value.inputCostPerMillionUsd === null) === (value.outputCostPerMillionUsd === null),
  'Input and output prices must both be supplied or both be empty',
);

export async function usageRoutes(app: FastifyInstance) {
  app.get('/quota', { preHandler: app.authenticate }, asyncRoute(async (request) => (
    workspaceAiQuotaStatus(request.user.workspaceId)
  )));

  app.put('/budget', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const input = parse(budgetInput, request.body, reply);
    if (!input) return;
    await query(
      `INSERT INTO workspace_ai_budgets(
         workspace_id,monthly_request_limit,monthly_token_limit,monthly_cost_limit_usd,
         input_cost_per_million_usd,output_cost_per_million_usd,warning_percent,hard_limit,updated_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(workspace_id) DO UPDATE SET
         monthly_request_limit=EXCLUDED.monthly_request_limit,
         monthly_token_limit=EXCLUDED.monthly_token_limit,
         monthly_cost_limit_usd=EXCLUDED.monthly_cost_limit_usd,
         input_cost_per_million_usd=EXCLUDED.input_cost_per_million_usd,
         output_cost_per_million_usd=EXCLUDED.output_cost_per_million_usd,
         warning_percent=EXCLUDED.warning_percent,hard_limit=EXCLUDED.hard_limit,
         updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [
        request.user.workspaceId, input.monthlyRequestLimit, input.monthlyTokenLimit,
        input.monthlyCostLimitUsd, input.inputCostPerMillionUsd, input.outputCostPerMillionUsd,
        input.warningPercent, input.hardLimit, request.user.sub,
      ],
    );
    await audit(request.user.workspaceId, request.user.sub, 'ai_budget.updated', 'workspace', request.user.workspaceId, {
      monthlyRequestLimit: input.monthlyRequestLimit,
      monthlyTokenLimit: input.monthlyTokenLimit,
      monthlyCostLimitUsd: input.monthlyCostLimitUsd,
      warningPercent: input.warningPercent,
      hardLimit: input.hardLimit,
      customPricingConfigured: input.inputCostPerMillionUsd !== null,
    });
    return workspaceAiQuotaStatus(request.user.workspaceId);
  }));
}

