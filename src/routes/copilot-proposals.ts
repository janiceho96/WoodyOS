import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approveAndApplyCopilotProposal, getExecutionReceipt } from '../copilot/apply.js';
import { rejectCopilotProposal } from '../copilot/repository.js';
import type { ExecutionReceipt } from '../copilot/types.js';
import { query } from '../db/client.js';
import { asyncRoute, parse } from '../lib/http.js';

const proposalParams = z.object({ proposalId: z.string().uuid() });
const receiptParams = z.object({ receiptId: z.string().uuid() });
const approvalInput = z.object({ idempotencyKey: z.string().uuid() }).strict();

function receiptView(receipt: ExecutionReceipt) {
  const { workspaceId: _workspaceId, actorId: _actorId, ...view } = receipt;
  return view;
}

async function proposalThreadId(workspaceId: string, proposalId: string) {
  return (await query<{ thread_id: string }>(
    'SELECT thread_id FROM copilot_proposals WHERE id=$1 AND workspace_id=$2',
    [proposalId, workspaceId],
  )).rows[0]?.thread_id;
}

export async function copilotProposalRoutes(app: FastifyInstance) {
  app.post('/proposals/:proposalId/reject', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const params = parse(proposalParams, request.params, reply); if (!params) return;
    const proposal = await rejectCopilotProposal({
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
      proposalId: params.proposalId,
    });
    request.log.info({
      requestId: request.id,
      threadId: await proposalThreadId(request.user.workspaceId, proposal.id),
      proposalId: proposal.id,
      contextSnapshotId: proposal.contextSnapshotId,
    }, 'Copilot proposal rejected');
    return proposal;
  }));

  app.post('/proposals/:proposalId/approve', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const params = parse(proposalParams, request.params, reply); if (!params) return;
    const input = parse(approvalInput, request.body, reply); if (!input) return;
    const receipt = await approveAndApplyCopilotProposal({
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
      actorRole: request.user.role,
      proposalId: params.proposalId,
      idempotencyKey: input.idempotencyKey,
    });
    request.log.info({
      requestId: request.id,
      threadId: await proposalThreadId(request.user.workspaceId, receipt.proposalId),
      proposalId: receipt.proposalId,
      contextSnapshotId: receipt.contextSnapshotId,
      receiptId: receipt.id,
    }, 'Copilot proposal applied');
    return receiptView(receipt);
  }));

  app.get('/receipts/:receiptId', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const params = parse(receiptParams, request.params, reply); if (!params) return;
    const receipt = await getExecutionReceipt(request.user.workspaceId, params.receiptId);
    if (!receipt) return reply.code(404).send({ error: 'COPILOT_RECEIPT_NOT_FOUND' });
    request.log.info({
      requestId: request.id,
      threadId: await proposalThreadId(request.user.workspaceId, receipt.proposalId),
      proposalId: receipt.proposalId,
      contextSnapshotId: receipt.contextSnapshotId,
      receiptId: receipt.id,
    }, 'Copilot receipt read');
    return receiptView(receipt);
  }));
}
