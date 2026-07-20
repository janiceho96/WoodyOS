ALTER TABLE knowledge_documents ADD COLUMN content TEXT;
CREATE TABLE knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id, ordinal)
);
CREATE INDEX knowledge_chunks_document_idx ON knowledge_chunks(document_id, ordinal);
CREATE INDEX knowledge_chunks_fts_idx ON knowledge_chunks USING GIN(search_vector);
CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks USING ivfflat(embedding vector_cosine_ops) WITH (lists = 100);
