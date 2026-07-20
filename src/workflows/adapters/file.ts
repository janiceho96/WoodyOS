import type { WorkflowAdapterContext } from './types.js';

export async function executeFileNode({ run, node }: WorkflowAdapterContext) {
  if (node.type !== 'output') throw new Error(`File adapter cannot execute ${node.type}`);
  if (node.config.output && typeof node.config.output === 'object' && !Array.isArray(node.config.output)) Object.assign(run.state, node.config.output as Record<string, unknown>);
  const fromNodeId = node.config.fromNodeId;
  const output = typeof fromNodeId === 'string' ? run.state[fromNodeId] : run.state;
  if (typeof fromNodeId === 'string' && !(fromNodeId in run.state)) throw new Error(`Output node ${node.id} references unavailable result ${fromNodeId}`);
  return { output, result: output, finished: true };
}

