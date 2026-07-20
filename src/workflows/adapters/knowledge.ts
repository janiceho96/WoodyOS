import { searchWorkspaceKnowledge } from '../../knowledge/retrieval.js';
import type { WorkflowAdapterContext } from './types.js';

export async function executeKnowledgeSearchNode(context: WorkflowAdapterContext) {
  const { run, node, resolve, emitEvent, setNodeOutput } = context;
  const resolvedQuery = resolve(node.config.query);
  const search = typeof resolvedQuery === 'string' ? resolvedQuery.trim() : JSON.stringify(resolvedQuery);
  if (!search || search.length < 2) throw new Error(`Knowledge search ${node.id} resolved to an empty query`);
  const limit = Math.min(20, Math.max(1, Number(node.config.limit ?? 8)));
  await emitEvent('knowledge.search_started', 'Searching workspace Knowledge', { limit });
  const results = await searchWorkspaceKnowledge(run.workspace_id, search, limit);
  const output = { query: search, count: results.length, results };
  await emitEvent('knowledge.search_completed', `Found ${results.length} Knowledge result${results.length === 1 ? '' : 's'}`, { count: results.length });
  setNodeOutput(output);
  return { output, result: output };
}

