CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  original_name TEXT NOT NULL,
  extension TEXT NOT NULL CHECK(extension IN ('pdf','docx','pptx','xlsx','xlsm','csv','md','txt','html','png','jpg','jpeg','webp')),
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 26214400),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scanning' CHECK(status IN ('scanning','extracting','ready','failed')),
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending','not_configured','clean','infected','failed')),
  scope TEXT NOT NULL DEFAULT 'saved' CHECK(scope IN ('task','conversation','saved','knowledge')),
  retention_policy TEXT NOT NULL DEFAULT 'keep' CHECK(retention_policy IN ('keep','30_days','delete_after_task','delete_after_conversation')),
  expires_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX files_workspace_sha256_unique ON files(workspace_id,sha256);
CREATE INDEX files_workspace_created_idx ON files(workspace_id,created_at DESC);
CREATE INDEX files_processing_idx ON files(status,created_at) WHERE status IN ('scanning','extracting');
CREATE INDEX files_expiry_idx ON files(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE file_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id UUID NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','failed')),
  content TEXT,
  summary TEXT,
  structured_content JSONB NOT NULL DEFAULT '{}'::jsonb,
  characters INTEGER NOT NULL DEFAULT 0 CHECK(characters >= 0),
  extractor_version TEXT NOT NULL DEFAULT '1',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE file_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  locator TEXT NOT NULL DEFAULT 'Document',
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(file_id,ordinal)
);

CREATE INDEX file_chunks_file_idx ON file_chunks(file_id,ordinal);
CREATE INDEX file_chunks_fts_idx ON file_chunks USING GIN(search_vector);

CREATE TABLE task_attachments (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  attached_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,file_id)
);

CREATE INDEX task_attachments_workspace_idx ON task_attachments(workspace_id,created_at DESC);

CREATE TABLE chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'New conversation',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_threads_workspace_idx ON chat_threads(workspace_id,updated_at DESC);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  token_input INTEGER NOT NULL DEFAULT 0 CHECK(token_input >= 0),
  token_output INTEGER NOT NULL DEFAULT 0 CHECK(token_output >= 0),
  estimated_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0 CHECK(estimated_cost_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_thread_idx ON chat_messages(thread_id,created_at,id);

CREATE TABLE chat_message_attachments (
  message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id,file_id)
);

CREATE INDEX chat_message_attachments_workspace_idx ON chat_message_attachments(workspace_id,created_at DESC);

ALTER TABLE knowledge_documents
  ADD COLUMN file_id UUID REFERENCES files(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX knowledge_documents_file_unique
  ON knowledge_documents(file_id) WHERE file_id IS NOT NULL;

ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_format_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_format_check
  CHECK(format IN ('pdf','docx','pptx','xlsx','html','md','txt','csv','json'));
