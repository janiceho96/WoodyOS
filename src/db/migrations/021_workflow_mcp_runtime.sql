ALTER TABLE mcp_tool_calls
  ADD COLUMN workflow_node_id TEXT,
  ADD COLUMN workflow_iteration_key TEXT,
  ADD COLUMN workflow_attempt INTEGER CHECK(workflow_attempt BETWEEN 1 AND 10),
  ADD COLUMN workflow_action_authorization_id UUID REFERENCES workflow_action_authorizations(id) ON DELETE SET NULL,
  ADD CONSTRAINT mcp_tool_calls_execution_owner_check
    CHECK(task_id IS NOT NULL OR workflow_run_id IS NOT NULL);

CREATE INDEX mcp_tool_calls_workflow_node_idx
  ON mcp_tool_calls(workflow_run_id,workflow_node_id,workflow_iteration_key,workflow_attempt)
  WHERE workflow_run_id IS NOT NULL;

CREATE UNIQUE INDEX mcp_tool_calls_workflow_authorization_unique
  ON mcp_tool_calls(workflow_action_authorization_id)
  WHERE workflow_action_authorization_id IS NOT NULL;

