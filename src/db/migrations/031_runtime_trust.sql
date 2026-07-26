ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'cancel_requested';
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'cancelling';
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'cancelled_with_side_effects';
ALTER TYPE workflow_run_status ADD VALUE IF NOT EXISTS 'cancel_requested';
ALTER TYPE workflow_run_status ADD VALUE IF NOT EXISTS 'cancelling';
ALTER TYPE workflow_run_status ADD VALUE IF NOT EXISTS 'cancelled_with_side_effects';

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS trace_id UUID,
  ADD COLUMN IF NOT EXISTS span_id UUID,
  ADD COLUMN IF NOT EXISTS parent_span_id UUID;

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS trace_id UUID,
  ADD COLUMN IF NOT EXISTS span_id UUID,
  ADD COLUMN IF NOT EXISTS parent_span_id UUID,
  ADD COLUMN IF NOT EXISTS error JSONB;

ALTER TABLE workflow_run_node_states
  ADD COLUMN IF NOT EXISTS trace_id UUID,
  ADD COLUMN IF NOT EXISTS span_id UUID,
  ADD COLUMN IF NOT EXISTS parent_span_id UUID;

ALTER TABLE workflow_run_events
  ADD COLUMN IF NOT EXISTS trace_id UUID,
  ADD COLUMN IF NOT EXISTS span_id UUID,
  ADD COLUMN IF NOT EXISTS parent_span_id UUID;

ALTER TABLE task_events
  ADD COLUMN IF NOT EXISTS trace_id UUID,
  ADD COLUMN IF NOT EXISTS span_id UUID,
  ADD COLUMN IF NOT EXISTS parent_span_id UUID;

ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS trace_id UUID,
  ADD COLUMN IF NOT EXISTS span_id UUID,
  ADD COLUMN IF NOT EXISTS parent_span_id UUID,
  ADD COLUMN IF NOT EXISTS runtime_error JSONB,
  ADD COLUMN IF NOT EXISTS on_expiration TEXT NOT NULL DEFAULT 'auto_reject'
    CHECK(on_expiration IN ('fail','escalate','auto_reject')),
  ADD COLUMN IF NOT EXISTS escalation_level INTEGER NOT NULL DEFAULT 0
    CHECK(escalation_level >= 0),
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

ALTER TABLE mcp_tool_calls
  ADD COLUMN IF NOT EXISTS trace_id UUID,
  ADD COLUMN IF NOT EXISTS span_id UUID,
  ADD COLUMN IF NOT EXISTS parent_span_id UUID,
  ADD COLUMN IF NOT EXISTS runtime_error JSONB;

CREATE INDEX IF NOT EXISTS tasks_trace_time_idx
  ON tasks(trace_id,created_at) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_trace_time_idx
  ON workflow_runs(trace_id,created_at) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_node_states_trace_time_idx
  ON workflow_run_node_states(trace_id,started_at) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_run_events_trace_time_idx
  ON workflow_run_events(trace_id,created_at) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_events_trace_time_idx
  ON task_events(trace_id,created_at) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS action_authorizations_trace_time_idx
  ON action_authorizations(trace_id,requested_at) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_tool_calls_trace_time_idx
  ON mcp_tool_calls(trace_id,requested_at) WHERE trace_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS execution_leases (
  subject_type TEXT NOT NULL CHECK(subject_type IN ('task','workflow_run')),
  subject_id UUID NOT NULL,
  owner_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(subject_type,subject_id)
);

CREATE INDEX IF NOT EXISTS execution_leases_expiry_idx
  ON execution_leases(expires_at);
