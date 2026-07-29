// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  type ChatThread,
  type OutputDocumentDetail,
  type TaskDetail,
} from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { EditableOutput } from '../../components/outputs/EditableOutput';
import type { CopilotEvent, CopilotProposalView } from '../../contracts/copilot';
import { CopilotContextProvider } from './CopilotContext';
import { WoodyChat } from './WoodyChat';

const taskId = '0d37888d-0f0b-4d87-aed1-a4a453d212f9';
const documentId = '45f0429e-a911-492e-96cd-62fa17276211';
const versionId = '6f4d43a5-28dd-4123-b99a-97f9a366aa00';
const threadId = 'f50ef45a-7488-44aa-b3e8-7b39b092ad42';
const workflowRunId = '8ce22b1e-452f-4f18-a466-a4a223993207';

const document: OutputDocumentDetail = {
  id: documentId,
  workspace_id: '0c46a071-6933-4de1-a602-e5310982a947',
  task_id: taskId,
  current_version_number: 1,
  created_by: null,
  created_at: '2026-07-29T10:00:00.000Z',
  updated_at: '2026-07-29T10:00:00.000Z',
  currentVersion: {
    id: versionId,
    workspace_id: '0c46a071-6933-4de1-a602-e5310982a947',
    document_id: documentId,
    version_number: 1,
    content: '# Original',
    content_hash: 'a'.repeat(64),
    created_by: null,
    created_at: '2026-07-29T10:00:00.000Z',
  },
  versions: [],
};
document.versions = [document.currentVersion];

const task: TaskDetail = {
  id: taskId,
  agent_id: 'a4ff1950-a596-40b4-89a1-37a0fddc5ac2',
  workflow_run_id: workflowRunId,
  title: 'Completed output',
  status: 'completed',
  created_at: '2026-07-29T09:00:00.000Z',
  updated_at: '2026-07-29T10:00:00.000Z',
  output: { content: '# Original' },
  events: [],
  artifacts: [],
  attachments: [],
};

const workspace: WorkspaceContextValue = {
  session: {
    accessToken: 'test',
    user: {
      id: '2a55d226-97a7-4de5-aa8c-258f79fdb824',
      email: 'test@example.test',
      displayName: 'Test User',
      onboarding: { version: 1, completed: true, lastStep: 6, completedAt: null, skippedAt: null },
    },
    workspace: { id: document.workspace_id, name: 'Test workspace', role: 'owner' },
  },
  data: { agents: [], tasks: [], workflows: [], documents: [], tools: [] },
  loading: false,
  refresh: vi.fn(),
  notice: '',
  error: '',
  report: vi.fn(),
  reportError: vi.fn(),
  clearMessage: vi.fn(),
  signOut: vi.fn(),
  openOnboarding: vi.fn(),
};

function wrapper(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceContext.Provider value={workspace}>
        <CopilotContextProvider>{children}</CopilotContextProvider>
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

function thread(messages: NonNullable<ChatThread['messages']> = []): ChatThread {
  return {
    id: threadId,
    title: 'Copilot thread',
    status: 'active',
    created_at: '2026-07-29T10:00:00.000Z',
    updated_at: '2026-07-29T10:00:00.000Z',
    messages,
  };
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.spyOn(api, 'chatThreads').mockResolvedValue({ data: [] });
  vi.spyOn(api, 'createChatThread').mockResolvedValue(thread());
  vi.spyOn(api, 'chatThread').mockResolvedValue(thread());
  vi.spyOn(api, 'attachCopilotContext').mockResolvedValue({
    id: 'd1f58c9a-1681-4a65-8949-9ae2956945bb',
    workflow: null,
    run: { id: workflowRunId, status: 'completed', workflowVersionId: null },
    task: { id: taskId, status: 'completed' },
    output: {
      documentId,
      versionId,
      versionNumber: 1,
      contentHash: 'a'.repeat(64),
    },
    capturedAt: '2026-07-29T10:00:00.000Z',
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Woody contextual conversation state', () => {
  it('opens from the selected EditableOutput and attaches its exact context', async () => {
    vi.spyOn(api, 'outputDocumentForTask').mockResolvedValue({ document });
    wrapper(<><EditableOutput task={task} refreshTask={vi.fn()}/><WoodyChat displayName="Test User"/></>);

    const refine = await screen.findByRole('button', { name: 'Refine with Woody' });
    await waitFor(() => expect((refine as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refine);

    expect(await screen.findByRole('dialog', { name: 'Chat with Woody' })).toBeTruthy();
    await waitFor(() => expect(api.attachCopilotContext).toHaveBeenCalledWith(threadId, {
      taskId,
      outputDocumentId: documentId,
      workflowRunId,
    }));
    expect(api.attachCopilotContext).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Current output context')).toBeTruthy();
  });

  it('initializes an original output before opening Copilot', async () => {
    vi.spyOn(api, 'outputDocumentForTask').mockResolvedValue({ document: null });
    const initialize = vi.spyOn(api, 'initializeOutputDocument').mockResolvedValue(document);
    wrapper(<><EditableOutput task={task} refreshTask={vi.fn()}/><WoodyChat displayName="Test User"/></>);

    const refine = await screen.findByRole('button', { name: 'Refine with Woody' });
    await waitFor(() => expect((refine as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refine);

    await waitFor(() => expect(initialize).toHaveBeenCalledWith(taskId));
    await waitFor(() => expect(api.attachCopilotContext).toHaveBeenCalledWith(threadId, {
      taskId,
      outputDocumentId: documentId,
      workflowRunId,
    }));
  });

  it('restores clarification cards and keeps the next turn in the same thread', async () => {
    const clarification: CopilotEvent = {
      type: 'clarification',
      proposalKind: 'output_refinement',
      questions: [{ id: 'audience', question: 'Who should read this output?' }],
    };
    vi.mocked(api.chatThreads).mockResolvedValue({ data: [thread()] });
    vi.mocked(api.chatThread).mockResolvedValue(thread([{
      id: 'message-1',
      role: 'assistant',
      content: 'One question first.',
      event: clarification,
      metadata: { event: clarification },
      created_at: '2026-07-29T10:00:00.000Z',
    }]));
    vi.spyOn(api, 'sendChatThreadMessage').mockResolvedValue({
      user: { id: 'message-2', role: 'user', content: 'Executives', created_at: '2026-07-29T10:01:00.000Z' },
      assistant: {
        id: 'message-3',
        role: 'assistant',
        content: 'One more question.',
        event: {
          type: 'clarification',
          proposalKind: 'output_refinement',
          questions: [{ id: 'tone', question: 'Should the tone be formal?' }],
        },
        created_at: '2026-07-29T10:01:01.000Z',
      },
      citations: [],
    });
    wrapper(<WoodyChat displayName="Test User"/>);
    fireEvent.click(screen.getByRole('button', { name: 'Chat with Woody' }));

    expect(await screen.findByText('Who should read this output?')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Woody' }), { target: { value: 'Executives' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(api.sendChatThreadMessage).toHaveBeenCalledWith(threadId, 'Executives', []));
    expect(await screen.findByText('Should the tone be formal?')).toBeTruthy();
  });

  it('reuses one approval idempotency key after a transport failure', async () => {
    const proposal: CopilotProposalView = {
      id: '6688bb45-a4f8-4261-8e71-ee8bd43dfe81',
      kind: 'output_refinement',
      status: 'ready_for_review',
      contextSnapshotId: 'd1f58c9a-1681-4a65-8949-9ae2956945bb',
      payload: {
        documentId,
        baseVersionId: versionId,
        baseVersionNumber: 1,
        baseContentHash: 'a'.repeat(64),
        proposedContent: '# Improved',
        proposedContentHash: 'b'.repeat(64),
        changeSummary: ['Clearer'],
      },
      payloadHash: 'c'.repeat(64),
      dependsOnOutputVersion: true,
      expiresAt: '2026-07-30T10:00:00.000Z',
      createdAt: '2026-07-29T10:00:00.000Z',
      appliedAt: null,
      errorCode: null,
    };
    const event: CopilotEvent = { type: 'refinement_preview', proposal };
    vi.mocked(api.chatThreads).mockResolvedValue({ data: [thread()] });
    vi.mocked(api.chatThread).mockResolvedValue(thread([{
      id: 'proposal-message',
      role: 'assistant',
      content: 'Review the proposal.',
      event,
      metadata: { event },
      created_at: '2026-07-29T10:00:00.000Z',
    }]));
    vi.spyOn(api, 'approveCopilotProposal')
      .mockRejectedValueOnce(new Error('NETWORK_ERROR'))
      .mockResolvedValueOnce({
        id: 'b75bad72-e0fd-41cf-bb83-86e0cb059147',
        proposalId: proposal.id,
        proposalKind: proposal.kind,
        contextSnapshotId: proposal.contextSnapshotId,
        idempotencyKey: 'server-echo',
        operation: 'output.version_created',
        status: 'succeeded',
        resource: { type: 'output_version', id: versionId, previousVersion: 1, resultingVersion: 2 },
        auditEventId: null,
        errorCode: null,
        createdAt: '2026-07-29T10:02:00.000Z',
      });
    wrapper(<WoodyChat displayName="Test User"/>);
    fireEvent.click(screen.getByRole('button', { name: 'Chat with Woody' }));
    const approve = await screen.findByRole('button', { name: 'Accept as new output version' });

    fireEvent.click(approve);
    await screen.findByText('NETWORK_ERROR');
    fireEvent.click(approve);
    await waitFor(() => expect(api.approveCopilotProposal).toHaveBeenCalledTimes(2));

    const firstKey = vi.mocked(api.approveCopilotProposal).mock.calls[0][1];
    const secondKey = vi.mocked(api.approveCopilotProposal).mock.calls[1][1];
    expect(secondKey).toBe(firstKey);
  });
});
