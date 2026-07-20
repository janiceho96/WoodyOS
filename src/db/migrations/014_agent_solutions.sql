CREATE TABLE agent_solution_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN ('starter','generated','imported')),
  solution_slug TEXT NOT NULL,
  solution_version INTEGER NOT NULL CHECK(solution_version > 0),
  solution_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
  solution_snapshot JSONB NOT NULL,
  created_resource_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  encrypted_source_prompt JSONB,
  prompt_hash TEXT,
  duplicate_of UUID REFERENCES agent_solution_installations(id) ON DELETE SET NULL,
  installed_by UUID NOT NULL REFERENCES users(id),
  last_test_run_id UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
  last_tested_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX agent_solution_installations_primary_version_idx
  ON agent_solution_installations(workspace_id,source_type,solution_slug,solution_version)
  WHERE duplicate_of IS NULL AND status <> 'archived';

CREATE INDEX agent_solution_installations_workspace_idx
  ON agent_solution_installations(workspace_id,created_at DESC);

CREATE TABLE agent_solution_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN ('generated','imported')),
  name TEXT NOT NULL,
  solution JSONB NOT NULL,
  encrypted_source_prompt JSONB,
  prompt_hash TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_solution_drafts_workspace_idx
  ON agent_solution_drafts(workspace_id,updated_at DESC);
