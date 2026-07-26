CREATE TABLE output_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  current_version_number INTEGER NOT NULL DEFAULT 1 CHECK(current_version_number >= 1),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id)
);

CREATE TABLE output_document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES output_documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK(version_number >= 1),
  content TEXT NOT NULL CHECK(length(btrim(content)) BETWEEN 1 AND 100000),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id,version_number)
);

ALTER TABLE artifacts
  ADD COLUMN output_document_version_id UUID
  REFERENCES output_document_versions(id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS artifacts_task_format_unique;

CREATE UNIQUE INDEX artifacts_task_format_legacy_unique
  ON artifacts(task_id,format)
  WHERE task_id IS NOT NULL AND output_document_version_id IS NULL;

CREATE UNIQUE INDEX artifacts_task_format_version_unique
  ON artifacts(task_id,format,output_document_version_id)
  WHERE task_id IS NOT NULL AND output_document_version_id IS NOT NULL;

CREATE INDEX output_documents_workspace_updated_idx
  ON output_documents(workspace_id,updated_at DESC);

CREATE INDEX output_versions_document_created_idx
  ON output_document_versions(document_id,version_number DESC);

CREATE INDEX artifacts_output_version_idx
  ON artifacts(output_document_version_id)
  WHERE output_document_version_id IS NOT NULL;
