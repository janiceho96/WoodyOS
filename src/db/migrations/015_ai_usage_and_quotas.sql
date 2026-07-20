CREATE TABLE workspace_ai_budgets (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  monthly_request_limit BIGINT CHECK(monthly_request_limit IS NULL OR monthly_request_limit > 0),
  monthly_token_limit BIGINT CHECK(monthly_token_limit IS NULL OR monthly_token_limit > 0),
  monthly_cost_limit_usd NUMERIC(12,4) CHECK(monthly_cost_limit_usd IS NULL OR monthly_cost_limit_usd > 0),
  input_cost_per_million_usd NUMERIC(12,6) CHECK(input_cost_per_million_usd IS NULL OR input_cost_per_million_usd >= 0),
  output_cost_per_million_usd NUMERIC(12,6) CHECK(output_cost_per_million_usd IS NULL OR output_cost_per_million_usd >= 0),
  warning_percent INTEGER NOT NULL DEFAULT 80 CHECK(warning_percent BETWEEN 1 AND 100),
  hard_limit BOOLEAN NOT NULL DEFAULT false,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(
    (input_cost_per_million_usd IS NULL AND output_cost_per_million_usd IS NULL)
    OR (input_cost_per_million_usd IS NOT NULL AND output_cost_per_million_usd IS NOT NULL)
  )
);

CREATE TABLE ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  workflow_run_id UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK(source IN ('task','prompt_compiler','historical_task')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_id TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  estimated_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0 CHECK(estimated_cost_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ai_usage_events_provider_request_idx
  ON ai_usage_events(workspace_id,provider,request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX ai_usage_events_workspace_period_idx
  ON ai_usage_events(workspace_id,created_at DESC);

CREATE TABLE ai_provider_quota_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_id TEXT,
  request_limit BIGINT CHECK(request_limit IS NULL OR request_limit >= 0),
  requests_remaining BIGINT CHECK(requests_remaining IS NULL OR requests_remaining >= 0),
  requests_reset_at TIMESTAMPTZ,
  token_limit BIGINT CHECK(token_limit IS NULL OR token_limit >= 0),
  tokens_remaining BIGINT CHECK(tokens_remaining IS NULL OR tokens_remaining >= 0),
  tokens_reset_at TIMESTAMPTZ,
  credit_remaining_usd NUMERIC(12,6) CHECK(credit_remaining_usd IS NULL OR credit_remaining_usd >= 0),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ai_provider_quota_snapshots_workspace_idx
  ON ai_provider_quota_snapshots(workspace_id,captured_at DESC);

INSERT INTO ai_usage_events(
  workspace_id,task_id,workflow_run_id,source,provider,model,request_id,
  input_tokens,output_tokens,estimated_cost_usd,created_at
)
SELECT
  t.workspace_id,t.id,t.workflow_run_id,'historical_task',
  COALESCE(NULLIF(current_setting('app.llm_provider', true),''),'historical'),
  a.model,'historical-task:' || t.id::text,t.token_input,t.token_output,t.estimated_cost_usd,
  COALESCE(t.completed_at,t.updated_at,t.created_at)
FROM tasks t
JOIN agents a ON a.id=t.agent_id
WHERE t.status='completed' AND (t.token_input > 0 OR t.token_output > 0 OR t.estimated_cost_usd > 0)
ON CONFLICT DO NOTHING;
