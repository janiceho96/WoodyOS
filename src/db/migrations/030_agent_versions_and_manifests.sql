CREATE TABLE IF NOT EXISTS agent_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  published_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id,version),
  FOREIGN KEY(agent_id,workspace_id)
    REFERENCES agents(id,workspace_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_versions_identity_workspace_idx
  ON agent_versions(id,agent_id,workspace_id);
CREATE INDEX IF NOT EXISTS agent_versions_workspace_agent_idx
  ON agent_versions(workspace_id,agent_id,version DESC);

CREATE OR REPLACE FUNCTION reject_agent_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Published agent versions are immutable'
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS agent_versions_immutable ON agent_versions;
CREATE TRIGGER agent_versions_immutable
BEFORE UPDATE ON agent_versions
FOR EACH ROW EXECUTE FUNCTION reject_agent_version_mutation();

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS published_version_id UUID;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS agent_version_id UUID,
  ADD COLUMN IF NOT EXISTS manifest_version INTEGER NOT NULL DEFAULT 1 CHECK(manifest_version > 0),
  ADD COLUMN IF NOT EXISTS execution_manifest JSONB;

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS manifest_version INTEGER NOT NULL DEFAULT 1 CHECK(manifest_version > 0),
  ADD COLUMN IF NOT EXISTS execution_manifest JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='agents_published_version_identity_fkey'
       AND conrelid='agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_published_version_identity_fkey
      FOREIGN KEY(published_version_id,id,workspace_id)
      REFERENCES agent_versions(id,agent_id,workspace_id)
      ON DELETE SET NULL (published_version_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='tasks_agent_version_identity_fkey'
       AND conrelid='tasks'::regclass
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_agent_version_identity_fkey
      FOREIGN KEY(agent_version_id,agent_id,workspace_id)
      REFERENCES agent_versions(id,agent_id,workspace_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

INSERT INTO agent_versions(workspace_id,agent_id,version,snapshot,published_by,created_at)
SELECT
  agent.workspace_id,
  agent.id,
  1,
  jsonb_build_object(
    'name',agent.name,
    'role',agent.role,
    'goal',agent.goal,
    'instructions',agent.instructions,
    'personality',agent.personality,
    'model',agent.model,
    'modelConfig',agent.model_config,
    'capabilities',agent.capabilities,
    'apiToolIds',agent.tool_ids,
    'memoryConfig',agent.memory_config,
    'avatarIdentity',agent.avatar_config
  ),
  agent.created_by,
  agent.updated_at
FROM agents agent
WHERE agent.status='active'
ON CONFLICT(agent_id,version) DO NOTHING;

UPDATE agents agent
SET published_version_id=version.id
FROM agent_versions version
WHERE version.agent_id=agent.id
  AND version.workspace_id=agent.workspace_id
  AND version.version=1
  AND agent.status='active'
  AND agent.published_version_id IS NULL;

UPDATE tasks task
SET agent_version_id=version.id
FROM agents agent
JOIN agent_versions version
  ON version.id=agent.published_version_id
 AND version.agent_id=agent.id
 AND version.workspace_id=agent.workspace_id
WHERE task.agent_id=agent.id
  AND task.workspace_id=agent.workspace_id
  AND task.agent_version_id IS NULL;

UPDATE tasks
SET execution_manifest=jsonb_build_object(
  'manifestVersion',1,
  'createdAt',created_at,
  'compatibility','legacy_partial'
)
WHERE execution_manifest IS NULL;

UPDATE workflow_runs
SET execution_manifest=jsonb_build_object(
  'manifestVersion',1,
  'createdAt',created_at,
  'compatibility','legacy_partial'
)
WHERE execution_manifest IS NULL;
