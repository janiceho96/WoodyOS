CREATE TABLE workflow_action_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  iteration_key TEXT NOT NULL DEFAULT 'root',
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 10),
  adapter TEXT NOT NULL CHECK(adapter IN ('api','mcp','browser')),
  resource_id UUID NOT NULL,
  operation TEXT NOT NULL,
  target_summary TEXT,
  risk_level TEXT NOT NULL CHECK(risk_level IN ('read','write','external_write','destructive','unknown')),
  arguments_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  arguments_hash TEXT NOT NULL CHECK(length(arguments_hash)=64),
  idempotency_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('awaiting_confirmation','approved','executing','rejected','expired','consumed','failed')),
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decision_comment TEXT,
  result_summary JSONB,
  encrypted_result JSONB,
  error_message TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  resolved_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX workflow_action_authorizations_active_unique
  ON workflow_action_authorizations(
    workflow_run_id,node_id,iteration_key,attempt,adapter,resource_id,operation,arguments_hash
  ) WHERE status IN ('awaiting_confirmation','approved','executing');

CREATE INDEX workflow_action_authorizations_run_idx
  ON workflow_action_authorizations(workflow_run_id,requested_at,node_id);

CREATE INDEX workflow_action_authorizations_pending_idx
  ON workflow_action_authorizations(workspace_id,status,expires_at)
  WHERE status='awaiting_confirmation';
