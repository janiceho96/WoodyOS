CREATE TABLE presentation_themes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(char_length(name) BETWEEN 2 AND 120),
  design_markdown TEXT NOT NULL CHECK(char_length(design_markdown) BETWEEN 20 AND 30000),
  theme JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, name)
);
CREATE UNIQUE INDEX presentation_themes_one_default_idx ON presentation_themes(workspace_id) WHERE is_default;
CREATE INDEX presentation_themes_workspace_idx ON presentation_themes(workspace_id, updated_at DESC);
