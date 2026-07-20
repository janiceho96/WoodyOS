CREATE TABLE workflow_editor_layouts (
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version BETWEEN 1 AND 100),
  positions JSONB NOT NULL DEFAULT '[]'::jsonb,
  viewport JSONB NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}'::jsonb,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workflow_id,schema_version)
);

CREATE INDEX workflow_editor_layouts_workspace_idx
  ON workflow_editor_layouts(workspace_id,updated_at DESC);

