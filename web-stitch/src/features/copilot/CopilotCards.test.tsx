// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CopilotContextView,
  CopilotProposalView,
  DraftAgentPayload,
  ExecutionReceiptView,
  OutputRefinementPayload,
} from '../../contracts/copilot';
import { CopilotContextCard } from './CopilotContextCard';
import { CopilotEventCard } from './CopilotEventCard';
import { DraftAgentProposalCard } from './DraftAgentProposalCard';
import { ExecutionReceiptCard } from './ExecutionReceiptCard';
import { RefinementProposalCard } from './RefinementProposalCard';

afterEach(cleanup);

const context: CopilotContextView = {
  id: 'd1f58c9a-1681-4a65-8949-9ae2956945bb',
  workflow: null,
  run: null,
  task: { id: '0d37888d-0f0b-4d87-aed1-a4a453d212f9', status: 'completed' },
  output: {
    documentId: '45f0429e-a911-492e-96cd-62fa17276211',
    versionId: '6f4d43a5-28dd-4123-b99a-97f9a366aa00',
    versionNumber: 1,
    contentHash: 'a'.repeat(64),
  },
  capturedAt: '2026-07-29T10:00:00.000Z',
};

const refinementPayload: OutputRefinementPayload = {
  documentId: context.output.documentId,
  baseVersionId: context.output.versionId,
  baseVersionNumber: 1,
  baseContentHash: context.output.contentHash,
  proposedContent: '# Improved result',
  proposedContentHash: 'b'.repeat(64),
  changeSummary: ['Clarified the conclusion'],
};

const draftPayload: DraftAgentPayload = {
  name: 'Draft Writer',
  role: 'Writer',
  goal: 'Create useful drafts',
  instructions: 'Use only approved output context.',
  personality: 'Calm',
  model: 'test-model',
  modelConfig: { temperature: 0.2, maxTokens: 2048, topP: 1 },
  capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: true },
  memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: true },
  status: 'draft',
  toolIds: [],
};

function proposal(
  kind: CopilotProposalView['kind'],
  status: CopilotProposalView['status'] = 'ready_for_review',
): CopilotProposalView {
  return {
    id: '6688bb45-a4f8-4261-8e71-ee8bd43dfe81',
    kind,
    status,
    contextSnapshotId: context.id,
    payload: kind === 'output_refinement' ? refinementPayload : draftPayload,
    payloadHash: 'c'.repeat(64),
    dependsOnOutputVersion: true,
    expiresAt: '2026-07-30T10:00:00.000Z',
    createdAt: '2026-07-29T10:00:00.000Z',
    appliedAt: status === 'applied' ? '2026-07-29T10:05:00.000Z' : null,
    errorCode: null,
  };
}

describe('Copilot cards', () => {
  it('shows a refinement preview and requires the explicit acceptance gesture', () => {
    const approve = vi.fn();
    const reject = vi.fn();
    render(<RefinementProposalCard proposal={proposal('output_refinement')} onApprove={approve} onReject={reject}/>);

    expect(screen.getByText('# Improved result')).toBeTruthy();
    const accept = screen.getByRole('button', { name: 'Accept as new output version' }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    fireEvent.click(accept);
    expect(approve).toHaveBeenCalledOnce();
  });

  it('shows every Draft-agent field and disables an already applied proposal', () => {
    render(<DraftAgentProposalCard
      proposal={proposal('draft_agent', 'applied')}
      onApprove={vi.fn()}
      onReject={vi.fn()}
    />);

    const rendered = document.body.textContent ?? '';
    for (const text of [
      draftPayload.name,
      draftPayload.role,
      draftPayload.goal,
      draftPayload.instructions,
      draftPayload.personality!,
      draftPayload.model,
      '0.2',
      '2048',
      'Draft',
      'No tools',
      'Web browser: Off',
      'Code interpreter: Off',
      'Knowledge base: On',
    ]) expect(rendered).toContain(text);
    expect((screen.getByRole('button', { name: 'Approve and create Draft agent' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Applied')).toBeTruthy();
  });

  it.each(['expired', 'superseded'] as const)('offers non-mutating regeneration for %s proposals', (status) => {
    const regenerate = vi.fn();
    render(<RefinementProposalCard
      proposal={proposal('output_refinement', status)}
      onApprove={vi.fn()}
      onReject={vi.fn()}
      onRegenerate={regenerate}
    />);

    expect((screen.getByRole('button', { name: 'Accept as new output version' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Generate a new proposal' }));
    expect(regenerate).toHaveBeenCalledOnce();
  });

  it('marks context freshness without exposing hashes', () => {
    const { rerender } = render(<CopilotContextCard context={context} currentOutputVersionId={context.output.versionId}/>);
    expect(screen.getByText('Current output context')).toBeTruthy();
    expect(document.body.textContent).not.toContain(context.output.contentHash);

    rerender(<CopilotContextCard context={context} currentOutputVersionId="a-newer-version"/>);
    expect(screen.getByText('Output changed — generate a new proposal')).toBeTruthy();
  });

  it('renders clarification questions as a typed event', () => {
    render(<CopilotEventCard
      event={{
        type: 'clarification',
        proposalKind: 'draft_agent',
        questions: [
          { id: 'audience', question: 'Who will use this agent?' },
          { id: 'tone', question: 'What tone should it use?' },
        ],
      }}
      onApprove={vi.fn()}
      onReject={vi.fn()}
    />);
    expect(screen.getByText('Who will use this agent?')).toBeTruthy();
    expect(screen.getByText('What tone should it use?')).toBeTruthy();
  });

  it('renders a safe retry action for retryable proposal failures', () => {
    const retry = vi.fn();
    render(<CopilotEventCard
      event={{
        type: 'proposal_error',
        code: 'COPILOT_PROPOSAL_SCHEMA_INVALID',
        message: 'The proposal response was invalid.',
        requestId: 'trace-1',
        retryable: true,
      }}
      onApprove={vi.fn()}
      onReject={vi.fn()}
      onRegenerate={vi.fn()}
      onRetry={retry}
    />);

    expect(screen.getByText('The proposal response was invalid.')).toBeTruthy();
    expect(screen.getByText('COPILOT_PROPOSAL_SCHEMA_INVALID')).toBeTruthy();
    expect(screen.getByText('Request ID: trace-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('links a successful receipt to the exact created resource', () => {
    const receipt: ExecutionReceiptView = {
      id: 'b75bad72-e0fd-41cf-bb83-86e0cb059147',
      proposalId: '6688bb45-a4f8-4261-8e71-ee8bd43dfe81',
      proposalKind: 'draft_agent',
      contextSnapshotId: context.id,
      idempotencyKey: 'dfeb2a71-78c3-455a-a5b6-b09c95975ebe',
      operation: 'agent.draft_created',
      status: 'succeeded',
      resource: { type: 'agent', id: 'a4ff1950-a596-40b4-89a1-37a0fddc5ac2' },
      auditEventId: null,
      errorCode: null,
      createdAt: '2026-07-29T10:05:00.000Z',
    };
    render(<ExecutionReceiptCard receipt={receipt}/>);
    const link = screen.getByRole('link', { name: 'Open Draft agent' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/agents/${receipt.resource.id}`);
  });
});
