CREATE TABLE workspace_ai_provider_configs (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai-compatible')),
  base_url TEXT,
  default_model TEXT NOT NULL,
  encrypted_api_key JSONB NOT NULL,
  api_key_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'untested' CHECK(status IN ('untested','healthy','error')),
  last_tested_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(provider <> 'openai-compatible' OR base_url IS NOT NULL)
);

CREATE INDEX workspace_ai_provider_status_idx ON workspace_ai_provider_configs(status,last_tested_at DESC);
