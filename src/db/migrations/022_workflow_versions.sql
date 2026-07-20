ALTER TABLE workflows
  ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','published','paused','archived')),
  ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 1 CHECK(draft_revision > 0);

UPDATE workflows SET status=CASE WHEN enabled THEN 'published' ELSE 'draft' END;

CREATE TABLE workflow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition JSONB NOT NULL,
  published_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workflow_id,version)
);

CREATE INDEX workflow_versions_workspace_idx
  ON workflow_versions(workspace_id,workflow_id,version DESC);

INSERT INTO workflow_versions(workspace_id,workflow_id,version,name,description,definition,published_by,created_at)
SELECT workspace_id,id,1,name,description,definition,created_by,updated_at
FROM workflows
WHERE enabled=true;

ALTER TABLE workflows
  ADD COLUMN published_version_id UUID REFERENCES workflow_versions(id) ON DELETE SET NULL;

UPDATE workflows w
SET published_version_id=v.id
FROM workflow_versions v
WHERE v.workflow_id=w.id AND v.version=1;

ALTER TABLE workflow_runs
  ADD COLUMN workflow_version_id UUID REFERENCES workflow_versions(id) ON DELETE SET NULL,
  ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'production' CHECK(run_mode IN ('test','production')),
  ADD COLUMN draft_revision INTEGER CHECK(draft_revision IS NULL OR draft_revision > 0),
  ADD COLUMN test_target_node_id TEXT;

UPDATE workflow_runs r
SET workflow_version_id=w.published_version_id
FROM workflows w
WHERE w.id=r.workflow_id AND w.published_version_id IS NOT NULL;

CREATE INDEX workflow_runs_lifecycle_idx
  ON workflow_runs(workflow_id,run_mode,draft_revision,status,created_at DESC);

CREATE INDEX workflows_status_idx
  ON workflows(workspace_id,status,updated_at DESC);
