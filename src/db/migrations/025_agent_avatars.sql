ALTER TABLE agents
  ADD COLUMN avatar_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT agents_avatar_config_object CHECK (jsonb_typeof(avatar_config) = 'object');

CREATE TABLE agent_avatar_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT 'image/webp' CHECK (mime_type = 'image/webp'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  original_filename TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_avatar_assets_workspace_idx ON agent_avatar_assets(workspace_id);
