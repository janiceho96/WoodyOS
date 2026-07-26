import { query } from '../db/client.js';

type ComparisonChunk = {
  file_id: string;
  ordinal: number;
  locator: string;
  content: string;
};

function words(value: string) {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? [])
      .filter((word) => !STOP_WORDS.has(word))
      .slice(0, 20_000),
  );
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'have',
  'has', 'had', 'not', 'but', 'you', 'your', 'their', 'into', 'about', 'can', 'will',
]);

function excerpt(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 360);
}

export async function compareFiles(workspaceId: string, fileIds: [string, string]) {
  const files = await query<{ id: string; original_name: string; status: string }>(
    `SELECT id,original_name,status FROM files
     WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY array_position($2::uuid[],id)`,
    [workspaceId, fileIds],
  );
  if (files.rowCount !== 2) throw Object.assign(new Error('FILE_NOT_FOUND'), { statusCode: 404 });
  if (files.rows.some((file) => file.status !== 'ready')) {
    throw Object.assign(new Error('FILE_NOT_READY'), { statusCode: 409 });
  }
  const chunks = await query<ComparisonChunk>(
    `SELECT file_id,ordinal,locator,content FROM file_chunks
     WHERE workspace_id=$1 AND file_id=ANY($2::uuid[]) AND ordinal < 150
     ORDER BY file_id,ordinal`,
    [workspaceId, fileIds],
  );
  const leftChunks = chunks.rows.filter((chunk) => chunk.file_id === fileIds[0]);
  const rightChunks = chunks.rows.filter((chunk) => chunk.file_id === fileIds[1]);
  const leftWords = words(leftChunks.map((chunk) => chunk.content).join('\n'));
  const rightWords = words(rightChunks.map((chunk) => chunk.content).join('\n'));
  const shared = [...leftWords].filter((word) => rightWords.has(word));
  const union = new Set([...leftWords, ...rightWords]);
  const distinctive = (source: Set<string>, other: Set<string>) => [...source].filter((word) => !other.has(word)).slice(0, 30);
  const rightNormalized = new Set(rightChunks.map((chunk) => excerpt(chunk.content).toLocaleLowerCase()));
  const sharedPassages = leftChunks
    .filter((chunk) => rightNormalized.has(excerpt(chunk.content).toLocaleLowerCase()))
    .slice(0, 8)
    .map((chunk) => ({ fileId: chunk.file_id, locator: chunk.locator, excerpt: excerpt(chunk.content) }));
  return {
    files: files.rows,
    similarityPercent: union.size ? Math.round((shared.length / union.size) * 100) : 0,
    sharedTerms: shared.slice(0, 30),
    distinctiveTerms: {
      [fileIds[0]]: distinctive(leftWords, rightWords),
      [fileIds[1]]: distinctive(rightWords, leftWords),
    },
    sharedPassages,
    samples: {
      [fileIds[0]]: leftChunks.slice(0, 6).map((chunk) => ({ locator: chunk.locator, excerpt: excerpt(chunk.content) })),
      [fileIds[1]]: rightChunks.slice(0, 6).map((chunk) => ({ locator: chunk.locator, excerpt: excerpt(chunk.content) })),
    },
    method: 'Deterministic local lexical comparison; no document content was sent to an AI provider.',
  };
}
