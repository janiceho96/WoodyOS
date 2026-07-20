CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  workflow_run_id UUID REFERENCES workflow_runs(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  format TEXT NOT NULL CHECK(format IN ('pdf','docx','pptx','xlsx')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','generating','ready','failed','skipped')),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT,
  size_bytes BIGINT CHECK(size_bytes IS NULL OR size_bytes >= 0),
  sha256 TEXT,
  source_hash TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CHECK((task_id IS NOT NULL)::integer + (workflow_run_id IS NOT NULL)::integer = 1)
);

CREATE UNIQUE INDEX artifacts_task_format_unique
  ON artifacts(task_id,format) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX artifacts_workflow_format_unique
  ON artifacts(workflow_run_id,format) WHERE workflow_run_id IS NOT NULL;
CREATE INDEX artifacts_workspace_created_idx ON artifacts(workspace_id,created_at DESC);
CREATE INDEX artifacts_pending_idx ON artifacts(status,created_at) WHERE status IN ('pending','queued','generating');

ALTER TABLE workflow_runs
  ADD COLUMN definition_snapshot JSONB,
  ADD COLUMN state JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN cursor JSONB,
  ADD COLUMN step_count INTEGER NOT NULL DEFAULT 0 CHECK(step_count >= 0),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE workflow_runs r
   SET definition_snapshot=w.definition,
       state=r.input,
       cursor=jsonb_build_object(
         'nodeId',
         (SELECT n->>'id' FROM jsonb_array_elements(w.definition->'nodes') n WHERE n->>'type'='trigger' LIMIT 1),
         'loops','{}'::jsonb
       )
  FROM workflows w
 WHERE w.id=r.workflow_id AND r.definition_snapshot IS NULL;

ALTER TABLE workflow_runs ALTER COLUMN definition_snapshot SET NOT NULL;

CREATE TABLE workflow_run_node_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  iteration_key TEXT NOT NULL DEFAULT 'root',
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 10),
  status TEXT NOT NULL CHECK(status IN ('running','waiting','retrying','completed','failed','skipped')),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workflow_run_id,node_id,iteration_key,attempt)
);

CREATE INDEX workflow_run_node_states_run_idx
  ON workflow_run_node_states(workflow_run_id,started_at,node_id);

ALTER TABLE tasks
  ADD COLUMN workflow_iteration_key TEXT NOT NULL DEFAULT 'root',
  ADD COLUMN workflow_attempt INTEGER NOT NULL DEFAULT 1 CHECK(workflow_attempt BETWEEN 1 AND 10);

CREATE UNIQUE INDEX tasks_workflow_node_attempt_unique
  ON tasks(workflow_run_id,workflow_node_id,workflow_iteration_key,workflow_attempt)
  WHERE workflow_run_id IS NOT NULL AND workflow_node_id IS NOT NULL;

ALTER TABLE workflow_approvals
  ADD COLUMN iteration_key TEXT NOT NULL DEFAULT 'root',
  ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 10);

CREATE UNIQUE INDEX workflow_approvals_node_iteration_unique
  ON workflow_approvals(workflow_run_id,node_id,iteration_key,attempt);
