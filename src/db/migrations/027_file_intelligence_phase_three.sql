ALTER TABLE files
  ADD COLUMN version_group_id UUID,
  ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1 CHECK(version_number > 0),
  ADD COLUMN replaces_file_id UUID REFERENCES files(id) ON DELETE SET NULL;

UPDATE files SET version_group_id=id WHERE version_group_id IS NULL;
ALTER TABLE files ALTER COLUMN version_group_id SET NOT NULL;

CREATE UNIQUE INDEX files_version_number_unique
  ON files(workspace_id,version_group_id,version_number);
CREATE INDEX files_version_history_idx
  ON files(workspace_id,version_group_id,version_number DESC);

CREATE TABLE artifact_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(char_length(name) BETWEEN 2 AND 120),
  format TEXT NOT NULL CHECK(format IN ('html')),
  design_markdown TEXT NOT NULL CHECK(char_length(design_markdown) BETWEEN 20 AND 30000),
  theme JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,format,name)
);

CREATE UNIQUE INDEX artifact_templates_one_default_idx
  ON artifact_templates(workspace_id,format) WHERE is_default;
CREATE INDEX artifact_templates_workspace_idx
  ON artifact_templates(workspace_id,format,updated_at DESC);

ALTER TABLE chat_messages
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
