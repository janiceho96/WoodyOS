import type { WorkflowDefinition, WorkflowNode } from './definition.js';

export type QualityLoopConfig = {
  workerAgentId: string;
  graderAgentId: string;
  revisionStrategy: 'same_worker' | 'dedicated_agent';
  revisionAgentId?: string;
  maximumRevisions: number;
  passingScore: number;
  onLimit: 'return_best' | 'human_review' | 'fail';
};

function agentNode(id: string, agentId: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: 'agent', config: { agentId, ...config } };
}

export function buildQualityLoopDefinition(config: QualityLoopConfig): WorkflowDefinition {
  if (config.revisionStrategy === 'dedicated_agent' && !config.revisionAgentId) {
    throw new Error('A dedicated revision agent is required');
  }
  const maximumRevisions = Math.max(0, Math.min(99, Math.trunc(config.maximumRevisions)));
  const passingScore = Math.max(0, Math.min(100, config.passingScore));
  const nodes: WorkflowNode[] = [
    { id: 'trigger', type: 'trigger', config: {} },
    {
      id: 'quality_loop',
      type: 'loop',
      config: {
        mode: 'while',
        condition: { path: 'nodes.grader.data.passed', operator: 'not_equals', value: true },
        maxIterations: maximumRevisions + 1,
        onLimit: config.onLimit === 'fail' ? 'fail' : 'exit',
        passingScore,
        quality: {
          graderNodeId: 'grader',
          workerNodeId: 'worker',
          revisionNodeId: config.revisionStrategy === 'dedicated_agent' ? 'revision_agent' : 'worker',
        },
      },
    },
    agentNode('worker', config.workerAgentId, {
      responsibility: 'Create the best possible candidate from the workflow input. On later iterations, apply all grader feedback in the workflow state.',
      expectedOutput: 'A complete candidate ready for independent grading.',
    }),
    agentNode('grader', config.graderAgentId, {
      responsibility: `Independently grade the latest candidate. Set passed=true only when score is at least ${passingScore}.`,
      expectedOutput: 'A structured verdict containing passed, score, feedback, and criteria.',
      outputContract: 'grader',
    }),
  ];
  const edges: WorkflowDefinition['edges'] = [
    { source: 'trigger', target: 'quality_loop' },
    { source: 'quality_loop', target: config.revisionStrategy === 'dedicated_agent' ? 'has_feedback' : 'worker', condition: 'body' },
    { source: 'worker', target: 'grader' },
    { source: 'grader', target: 'quality_loop', condition: 'continue' },
  ];

  if (config.revisionStrategy === 'dedicated_agent') {
    nodes.push(
      { id: 'has_feedback', type: 'condition', config: { path: 'nodes.grader.data.feedback', operator: 'exists' } },
      agentNode('revision_agent', config.revisionAgentId!, {
        responsibility: 'Revise the latest candidate using every item of grader feedback while preserving correct material.',
        expectedOutput: 'A complete revised candidate ready for another independent grade.',
      }),
    );
    edges.push(
      { source: 'has_feedback', target: 'revision_agent', condition: 'true' },
      { source: 'has_feedback', target: 'worker', condition: 'false' },
      { source: 'revision_agent', target: 'grader' },
    );
  }

  if (config.onLimit === 'human_review') {
    nodes.push(
      { id: 'limit_reason', type: 'condition', config: { path: 'nodes.quality_loop.reason', operator: 'equals', value: 'limit_exit' } },
      { id: 'human_review', type: 'approval', config: { prompt: 'The quality limit was reached. Review the best candidate before accepting it.' } },
      { id: 'output', type: 'output', config: { fromNodeId: 'quality_loop' } },
    );
    edges.push(
      { source: 'quality_loop', target: 'limit_reason', condition: 'done' },
      { source: 'limit_reason', target: 'human_review', condition: 'true' },
      { source: 'limit_reason', target: 'output', condition: 'false' },
      { source: 'human_review', target: 'output' },
    );
  } else {
    nodes.push({ id: 'output', type: 'output', config: { fromNodeId: 'quality_loop' } });
    edges.push({ source: 'quality_loop', target: 'output', condition: 'done' });
  }
  return { nodes, edges };
}
