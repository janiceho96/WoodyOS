CREATE TABLE task_runtime_checkpoints (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  checkpoint_version INTEGER NOT NULL DEFAULT 1,
  encrypted_state JSONB NOT NULL,
  pending_tool_call_id UUID UNIQUE REFERENCES mcp_tool_calls(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_confirmation'
    CHECK (status IN ('awaiting_confirmation', 'approved', 'resuming', 'completed', 'rejected', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX task_runtime_checkpoints_workspace_status_idx
  ON task_runtime_checkpoints(workspace_id, status, updated_at);
