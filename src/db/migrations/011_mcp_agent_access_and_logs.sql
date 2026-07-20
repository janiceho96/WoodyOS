CREATE TABLE mcp_agent_access (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  permission_level TEXT NOT NULL DEFAULT 'read'
    CHECK (permission_level IN ('read', 'read_write')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  assigned_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_id, connection_id)
);

CREATE TABLE mcp_agent_tool_access (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mcp_tool_id UUID NOT NULL REFERENCES mcp_connection_tools(id) ON DELETE CASCADE,
  permission_level TEXT NOT NULL DEFAULT 'read'
    CHECK (permission_level IN ('read', 'read_write')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  assigned_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_id, mcp_tool_id)
);

CREATE TABLE mcp_tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES mcp_connections(id) ON DELETE RESTRICT,
  mcp_tool_id UUID NOT NULL REFERENCES mcp_connection_tools(id) ON DELETE RESTRICT,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  workflow_run_id UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'awaiting_confirmation', 'running', 'succeeded', 'failed', 'rejected', 'cancelled')),
  risk_level TEXT NOT NULL
    CHECK (risk_level IN ('read', 'write', 'destructive', 'external_write', 'unknown')),
  arguments_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  arguments_hash TEXT NOT NULL,
  result_summary JSONB,
  error_code TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  idempotency_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE mcp_tool_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_call_id UUID NOT NULL UNIQUE REFERENCES mcp_tool_calls(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  action_summary TEXT NOT NULL,
  target_summary TEXT,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decision_comment TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX mcp_agent_access_connection_idx
  ON mcp_agent_access(connection_id, enabled);
CREATE INDEX mcp_agent_tool_access_tool_idx
  ON mcp_agent_tool_access(mcp_tool_id, enabled);
CREATE INDEX mcp_tool_calls_workspace_time_idx
  ON mcp_tool_calls(workspace_id, requested_at DESC);
CREATE INDEX mcp_tool_calls_task_idx
  ON mcp_tool_calls(task_id, requested_at DESC)
  WHERE task_id IS NOT NULL;
CREATE INDEX mcp_tool_confirmations_pending_idx
  ON mcp_tool_confirmations(status, expires_at)
  WHERE status = 'pending';
