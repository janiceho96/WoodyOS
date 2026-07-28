CREATE TABLE IF NOT EXISTS quality_history_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  automated_revision INTEGER NOT NULL DEFAULT 0 CHECK(automated_revision >= 0),
  manual_revision INTEGER NOT NULL DEFAULT 0 CHECK(manual_revision >= 0),
  candidate_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  output_document_version_id UUID NOT NULL REFERENCES output_document_versions(id) ON DELETE RESTRICT,
  candidate_hash TEXT NOT NULL CHECK(candidate_hash ~ '^[a-f0-9]{64}$'),
  grader_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  grader_agent_version_id UUID NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  model_identity TEXT NOT NULL CHECK(length(btrim(model_identity)) > 0),
  result JSONB NOT NULL,
  exit_reason TEXT,
  trace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workflow_run_id,sequence)
);

CREATE INDEX IF NOT EXISTS quality_history_workspace_run_sequence_idx
  ON quality_history_entries(workspace_id,workflow_run_id,sequence);
CREATE INDEX IF NOT EXISTS quality_history_candidate_version_idx
  ON quality_history_entries(output_document_version_id);
CREATE INDEX IF NOT EXISTS quality_history_grader_version_idx
  ON quality_history_entries(grader_agent_version_id);
CREATE INDEX IF NOT EXISTS quality_history_trace_idx
  ON quality_history_entries(trace_id,created_at);

CREATE OR REPLACE FUNCTION reject_quality_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Quality history entries are immutable'
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS quality_history_entries_immutable ON quality_history_entries;
CREATE TRIGGER quality_history_entries_immutable
BEFORE UPDATE OR DELETE ON quality_history_entries
FOR EACH ROW EXECUTE FUNCTION reject_quality_history_mutation();

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS memory_type TEXT,
  ADD COLUMN IF NOT EXISTS scope TEXT,
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS verification_status TEXT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES memories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0;

UPDATE memories
   SET memory_type=COALESCE(
         memory_type,
         CASE kind
           WHEN 'user' THEN 'preference'
           WHEN 'knowledge' THEN 'fact'
           WHEN 'conversation' THEN 'summary'
           ELSE 'hypothesis'
         END
       ),
       scope=COALESCE(
         scope,
         CASE
           WHEN agent_id IS NOT NULL THEN 'agent'
           WHEN user_id IS NOT NULL THEN 'user'
           ELSE 'workspace'
         END
       ),
       source_type=COALESCE(
         source_type,
         CASE kind
           WHEN 'user' THEN 'user'
           WHEN 'knowledge' THEN 'knowledge'
           WHEN 'conversation' THEN 'conversation'
           ELSE 'legacy'
         END
       ),
       verification_status=COALESCE(
         verification_status,
         CASE kind
           WHEN 'user' THEN 'user_confirmed'
           ELSE 'unverified'
         END
       )
 WHERE memory_type IS NULL
    OR scope IS NULL
    OR source_type IS NULL
    OR verification_status IS NULL;

ALTER TABLE memories
  ALTER COLUMN memory_type SET NOT NULL,
  ALTER COLUMN scope SET NOT NULL,
  ALTER COLUMN verification_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='memories_memory_type_check'
       AND conrelid='memories'::regclass
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_memory_type_check
      CHECK(memory_type IN (
        'preference','fact','decision','project_context','workflow_result',
        'error_resolution','summary','hypothesis'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='memories_scope_check'
       AND conrelid='memories'::regclass
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_scope_check
      CHECK(scope IN ('workspace','agent','user'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='memories_verification_status_check'
       AND conrelid='memories'::regclass
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_verification_status_check
      CHECK(verification_status IN (
        'user_confirmed','agent_inferred','system_generated','unverified',
        'disputed','superseded'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='memories_confidence_check'
       AND conrelid='memories'::regclass
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_confidence_check
      CHECK(confidence BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='memories_access_count_check'
       AND conrelid='memories'::regclass
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_access_count_check
      CHECK(access_count >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS memories_workspace_scope_status_idx
  ON memories(workspace_id,scope,verification_status,created_at DESC);
CREATE INDEX IF NOT EXISTS memories_eligible_expiry_idx
  ON memories(workspace_id,expires_at)
  WHERE verification_status NOT IN ('disputed','superseded');
CREATE INDEX IF NOT EXISTS memories_superseded_by_idx
  ON memories(superseded_by)
  WHERE superseded_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_regression_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  input JSONB NOT NULL,
  fixtures JSONB NOT NULL DEFAULT '{}'::jsonb,
  assertions JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_regression_cases_workspace_workflow_idx
  ON workflow_regression_cases(workspace_id,workflow_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_evaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  regression_case_id UUID NOT NULL REFERENCES workflow_regression_cases(id) ON DELETE CASCADE,
  execution_manifest JSONB NOT NULL,
  trace_id UUID NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','passed','failed')),
  measurements JSONB NOT NULL DEFAULT '{}'::jsonb,
  assertion_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS workflow_evaluation_runs_workspace_case_idx
  ON workflow_evaluation_runs(workspace_id,regression_case_id,started_at DESC);
CREATE INDEX IF NOT EXISTS workflow_evaluation_runs_version_idx
  ON workflow_evaluation_runs(workflow_version_id,started_at DESC);
CREATE INDEX IF NOT EXISTS workflow_evaluation_runs_trace_idx
  ON workflow_evaluation_runs(trace_id);
