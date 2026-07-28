export async function embeddingFor(
  text: string,
  options: { signal?: AbortSignal } = {},
): Promise<number[] | null> {
  if (!process.env.EMBEDDING_API_URL) return null;
  const response = await fetch(process.env.EMBEDDING_API_URL, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.EMBEDDING_API_KEY ? { authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` } : {}) }, body: JSON.stringify({ input: text, model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small' }), signal: options.signal });
  if (!response.ok) throw new Error(`Embedding service returned ${response.status}`);
  const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
  const vector = payload.data?.[0]?.embedding;
  if (!vector || vector.length !== 1536) throw new Error('Embedding service must return a 1536-dimension vector');
  return vector;
}
