export type CopilotProposalKind = 'output_refinement' | 'draft_agent';

export type CopilotProposalStatus =
  | 'ready_for_review'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'failed';

export type ClarificationQuestion = { id: string; question: string };

export type CopilotContextRequest = {
  workflowId?: string;
  workflowRunId?: string;
  taskId: string;
  outputDocumentId: string;
};

export type CopilotContextSnapshot = {
  schemaVersion: 1;
  workspaceId: string;
  actorId: string;
  workflow: {
    id: string;
    publishedVersionId: string | null;
    draftRevision: number;
  } | null;
  run: {
    id: string;
    status: string;
    workflowVersionId: string | null;
  } | null;
  task: { id: string; status: string };
  output: {
    documentId: string;
    versionId: string;
    versionNumber: number;
    contentHash: string;
  };
  capturedAt: string;
};

export type CopilotContextSnapshotRecord = {
  id: string;
  threadId: string;
  snapshot: CopilotContextSnapshot;
  createdAt: string;
};

export type CopilotContextView = {
  id: string;
  workflow: CopilotContextSnapshot['workflow'];
  run: CopilotContextSnapshot['run'];
  task: CopilotContextSnapshot['task'];
  output: CopilotContextSnapshot['output'];
  capturedAt: string;
};

export type DraftAgentPayload = {
  name: string;
  role: string;
  goal: string;
  instructions: string;
  personality: string | null;
  model: string;
  modelConfig: { temperature: number; maxTokens: number; topP: number };
  capabilities: { webBrowser: false; codeInterpreter: false; knowledgeBase: boolean };
  memoryConfig: { shortTerm: boolean; longTerm: boolean; knowledgeBase: boolean };
  status: 'draft';
  toolIds: [];
};

export type OutputRefinementPayload = {
  documentId: string;
  baseVersionId: string;
  baseVersionNumber: number;
  baseContentHash: string;
  proposedContent: string;
  proposedContentHash: string;
  changeSummary: string[];
};

export type CopilotGeneratedTurn =
  | { type: 'clarification'; proposalKind: CopilotProposalKind; questions: ClarificationQuestion[] }
  | { type: 'refinement_candidate'; proposedContent: string; changeSummary: string[] }
  | { type: 'draft_agent_candidate'; candidate: unknown; dependsOnOutputVersion: boolean }
  | { type: 'message'; content: string }
  | { type: 'unsupported'; content: string };

export type CopilotProposalView = {
  id: string;
  kind: CopilotProposalKind;
  status: CopilotProposalStatus;
  contextSnapshotId: string;
  payload: OutputRefinementPayload | DraftAgentPayload;
  payloadHash: string;
  dependsOnOutputVersion: boolean;
  expiresAt: string;
  createdAt: string;
  appliedAt: string | null;
  errorCode: string | null;
};

export type ExecutionReceipt = {
  id: string;
  workspaceId: string;
  proposalId: string;
  proposalKind: CopilotProposalKind;
  contextSnapshotId: string;
  idempotencyKey: string;
  operation: 'output.version_created' | 'agent.draft_created';
  status: 'succeeded' | 'failed';
  actorId: string;
  resource: {
    type: 'output_version' | 'agent';
    id: string | null;
    previousVersion?: number;
    resultingVersion?: number;
  };
  auditEventId: string | null;
  errorCode: string | null;
  createdAt: string;
};

export type ExecutionReceiptView = Omit<ExecutionReceipt, 'workspaceId' | 'actorId'>;

export type CopilotEvent =
  | { type: 'clarification'; proposalKind: CopilotProposalKind; questions: ClarificationQuestion[] }
  | { type: 'refinement_preview'; proposal: CopilotProposalView }
  | { type: 'agent_proposal'; proposal: CopilotProposalView }
  | { type: 'execution_receipt'; receipt: ExecutionReceiptView }
  | { type: 'message'; content: string };
