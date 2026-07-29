CREATE TABLE copilot_context_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL,
  workflow_run_id UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  output_document_id UUID NOT NULL REFERENCES output_documents(id) ON DELETE CASCADE,
  output_version_id UUID NOT NULL REFERENCES output_document_versions(id) ON DELETE RESTRICT,
  snapshot JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX copilot_context_snapshots_thread_idx
  ON copilot_context_snapshots(thread_id,created_at DESC);

CREATE TABLE copilot_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  context_snapshot_id UUID NOT NULL REFERENCES copilot_context_snapshots(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('output_refinement','draft_agent')),
  status TEXT NOT NULL DEFAULT 'ready_for_review'
    CHECK(status IN ('ready_for_review','approved','applying','applied','rejected','expired','superseded','failed')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  depends_on_output_version BOOLEAN NOT NULL DEFAULT false,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX copilot_proposals_active_idx
  ON copilot_proposals(workspace_id,thread_id,kind,expires_at)
  WHERE status IN ('ready_for_review','approved','applying');

CREATE TABLE copilot_proposal_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL UNIQUE REFERENCES copilot_proposals(id) ON DELETE RESTRICT,
  context_snapshot_id UUID NOT NULL REFERENCES copilot_context_snapshots(id) ON DELETE RESTRICT,
  approved_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,approved_by,idempotency_key)
);

CREATE TABLE copilot_execution_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL UNIQUE REFERENCES copilot_proposals(id) ON DELETE RESTRICT,
  approval_id UUID NOT NULL UNIQUE REFERENCES copilot_proposal_approvals(id) ON DELETE RESTRICT,
  context_snapshot_id UUID NOT NULL REFERENCES copilot_context_snapshots(id) ON DELETE RESTRICT,
  proposal_kind TEXT NOT NULL CHECK(proposal_kind IN ('output_refinement','draft_agent')),
  idempotency_key UUID NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('output.version_created','agent.draft_created')),
  status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('output_version','agent')),
  resource_id UUID,
  previous_version INTEGER CHECK(previous_version IS NULL OR previous_version > 0),
  resulting_version INTEGER CHECK(resulting_version IS NULL OR resulting_version > 0),
  audit_event_id UUID REFERENCES audit_events(id) ON DELETE SET NULL,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,actor_id,idempotency_key)
);

ALTER TABLE chat_messages
  ADD COLUMN context_snapshot_id UUID REFERENCES copilot_context_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN proposal_id UUID REFERENCES copilot_proposals(id) ON DELETE SET NULL,
  ADD COLUMN execution_receipt_id UUID REFERENCES copilot_execution_receipts(id) ON DELETE SET NULL;

CREATE INDEX chat_messages_context_idx
  ON chat_messages(context_snapshot_id) WHERE context_snapshot_id IS NOT NULL;
CREATE INDEX chat_messages_proposal_idx
  ON chat_messages(proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX chat_messages_receipt_idx
  ON chat_messages(execution_receipt_id) WHERE execution_receipt_id IS NOT NULL;
