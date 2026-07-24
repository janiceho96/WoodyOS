ALTER TABLE workflow_action_authorizations RENAME TO action_authorizations;

ALTER TABLE action_authorizations
  ADD COLUMN subject_type TEXT NOT NULL DEFAULT 'workflow_run'
    CHECK(subject_type IN ('workflow_run','task')),
  ADD COLUMN task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  ADD COLUMN agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN action_key TEXT;

UPDATE action_authorizations
SET action_key = node_id || ':' || iteration_key || ':' || attempt::text
WHERE action_key IS NULL;

ALTER TABLE action_authorizations
  ALTER COLUMN action_key SET NOT NULL,
  ALTER COLUMN workflow_run_id DROP NOT NULL,
  ALTER COLUMN node_id DROP NOT NULL,
  ALTER COLUMN iteration_key DROP NOT NULL,
  ALTER COLUMN attempt DROP NOT NULL,
  ADD CONSTRAINT action_authorizations_subject_check CHECK(
    (subject_type='workflow_run' AND workflow_run_id IS NOT NULL AND task_id IS NULL AND node_id IS NOT NULL AND iteration_key IS NOT NULL AND attempt IS NOT NULL)
    OR
    (subject_type='task' AND task_id IS NOT NULL AND agent_id IS NOT NULL)
  );

DROP INDEX workflow_action_authorizations_active_unique;
DROP INDEX workflow_action_authorizations_run_idx;
DROP INDEX workflow_action_authorizations_pending_idx;

CREATE UNIQUE INDEX action_authorizations_workflow_active_unique
  ON action_authorizations(
    workflow_run_id,action_key,adapter,resource_id,operation,arguments_hash
  ) WHERE subject_type='workflow_run' AND status IN ('awaiting_confirmation','approved','executing');

CREATE UNIQUE INDEX action_authorizations_task_active_unique
  ON action_authorizations(
    task_id,action_key,adapter,resource_id,operation,arguments_hash
  ) WHERE subject_type='task' AND status IN ('awaiting_confirmation','approved','executing');

CREATE INDEX action_authorizations_run_idx
  ON action_authorizations(workflow_run_id,requested_at,node_id)
  WHERE workflow_run_id IS NOT NULL;

CREATE INDEX action_authorizations_task_idx
  ON action_authorizations(task_id,requested_at)
  WHERE task_id IS NOT NULL;

CREATE INDEX action_authorizations_pending_idx
  ON action_authorizations(workspace_id,status,expires_at)
  WHERE status='awaiting_confirmation';

ALTER TABLE task_runtime_checkpoints
  ADD COLUMN pending_action_authorization_id UUID UNIQUE REFERENCES action_authorizations(id) ON DELETE SET NULL;

ALTER TABLE mcp_tool_calls
  RENAME COLUMN workflow_action_authorization_id TO action_authorization_id;

ALTER INDEX mcp_tool_calls_workflow_authorization_unique
  RENAME TO mcp_tool_calls_action_authorization_unique;
