import { query } from '../db/client.js';

export type KnowledgeResult = {
  chunkId: string;
  documentId: string;
  documentName: string;
  ordinal: number;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
};

export async function searchWorkspaceKnowledge(workspaceId: string, requestText: string, limit = 8): Promise<KnowledgeResult[]> {
  const search = requestText.replace(/\s+/g, ' ').trim().slice(0, 1_000);
  if (search.length < 2) return [];
  const result = await query<{
    id: string;
    document_id: string;
    document_name: string;
    ordinal: number;
    content: string;
    metadata: Record<string, unknown>;
    score: number;
  }>(
    `SELECT c.id,c.document_id,d.name document_name,c.ordinal,c.content,c.metadata,
     ts_rank(c.search_vector,websearch_to_tsquery('simple',$2)) score
     FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
     WHERE c.workspace_id=$1 AND d.status IN ('ready','indexed','completed')
       AND c.search_vector @@ websearch_to_tsquery('simple',$2)
     ORDER BY score DESC,c.ordinal LIMIT $3`,
    [workspaceId, search, Math.min(20, Math.max(1, limit))],
  );
  return result.rows.map((row) => ({
    chunkId: row.id,
    documentId: row.document_id,
    documentName: row.document_name,
    ordinal: row.ordinal,
    content: row.content.slice(0, 4_000),
    metadata: row.metadata ?? {},
    score: Number(row.score),
  }));
}

