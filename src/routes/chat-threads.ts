import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getExecutionReceipt } from '../copilot/apply.js';
import { contextView, resolveCopilotContext } from '../copilot/context.js';
import { orchestrateCopilotTurn } from '../copilot/orchestrator.js';
import { getProposalView } from '../copilot/repository.js';
import type { CopilotEvent, ExecutionReceipt } from '../copilot/types.js';
import { db, query } from '../db/client.js';
import { retrieveChatAttachmentContext } from '../files/context.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { answerWoody, type WoodyChatMessage } from './copilot.js';

const createThreadInput = z.object({ title: z.string().trim().min(1).max(200).optional() });
const messageInput = z.object({
  content: z.string().trim().min(1).max(8_000),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
});
const contextInput = z.object({
  workflowId: z.string().uuid().optional(),
  workflowRunId: z.string().uuid().optional(),
  taskId: z.string().uuid(),
  outputDocumentId: z.string().uuid(),
}).strict();

function receiptView(receipt: ExecutionReceipt) {
  const { workspaceId: _workspaceId, actorId: _actorId, ...view } = receipt;
  return view;
}

export async function chatThreadRoutes(app: FastifyInstance) {
  app.get('/threads', { preHandler: app.authenticate }, asyncRoute(async (request) => {
    const threads = await query(
      `SELECT thread.id,thread.title,thread.status,thread.created_at,thread.updated_at,
        (SELECT content FROM chat_messages WHERE thread_id=thread.id ORDER BY created_at DESC,id DESC LIMIT 1) last_message,
        (SELECT count(*)::integer FROM chat_messages WHERE thread_id=thread.id) message_count
       FROM chat_threads thread
       WHERE thread.workspace_id=$1 AND thread.created_by=$2 AND thread.status='active'
       ORDER BY thread.updated_at DESC LIMIT 50`,
      [request.user.workspaceId, request.user.sub],
    );
    return { data: threads.rows };
  }));

  app.post('/threads', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(createThreadInput, request.body ?? {}, reply); if (!input) return;
    const thread = (await query(
      `INSERT INTO chat_threads(workspace_id,created_by,title) VALUES($1,$2,$3) RETURNING *`,
      [request.user.workspaceId, request.user.sub, input.title ?? 'New conversation'],
    )).rows[0];
    return reply.code(201).send({ ...thread, messages: [] });
  }));

  app.get('/threads/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const threadId = (request.params as { id: string }).id;
    const thread = (await query(
      `SELECT * FROM chat_threads WHERE id=$1 AND workspace_id=$2 AND created_by=$3`,
      [threadId, request.user.workspaceId, request.user.sub],
    )).rows[0];
    if (!thread) return reply.code(404).send({ error: 'CHAT_THREAD_NOT_FOUND' });
    const messages = await query(
      `SELECT message.*,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id',file.id,'original_name',file.original_name,'extension',file.extension,'mime_type',file.mime_type,
            'size_bytes',file.size_bytes,'status',file.status,'scan_status',file.scan_status,'scope',file.scope,
            'retention_policy',file.retention_policy,'error_message',file.error_message,'metadata',file.metadata,
            'version_group_id',file.version_group_id,'version_number',file.version_number,'replaces_file_id',file.replaces_file_id,
            'created_at',file.created_at,'updated_at',file.updated_at,'completed_at',file.completed_at
          ) ORDER BY attachment.created_at)
          FROM chat_message_attachments attachment JOIN files file ON file.id=attachment.file_id
          WHERE attachment.message_id=message.id
        ),'[]'::jsonb) attachments
       FROM chat_messages message WHERE message.thread_id=$1 AND message.workspace_id=$2
       ORDER BY message.created_at,message.id`,
      [threadId, request.user.workspaceId],
    );
    const hydratedMessages = await Promise.all(messages.rows.map(async (raw) => {
      const message = raw as Record<string, unknown> & {
        metadata?: { event?: CopilotEvent };
        proposal_id?: string | null;
        execution_receipt_id?: string | null;
      };
      let event = message.metadata?.event;
      if (message.proposal_id && (event?.type === 'refinement_preview' || event?.type === 'agent_proposal')) {
        const proposal = await getProposalView(request.user.workspaceId, message.proposal_id);
        if (proposal) event = { ...event, proposal };
      }
      if (message.execution_receipt_id) {
        const receipt = await getExecutionReceipt(request.user.workspaceId, message.execution_receipt_id);
        if (receipt) event = { type: 'execution_receipt', receipt: receiptView(receipt) };
      }
      return {
        ...message,
        ...(event ? { event, metadata: { ...message.metadata, event } } : {}),
      };
    }));
    return { ...thread, messages: hydratedMessages };
  }));

  app.post('/threads/:id/messages', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(messageInput, request.body, reply); if (!input) return;
    const threadId = (request.params as { id: string }).id;
    const thread = (await query<{ id: string; title: string }>(
      `SELECT id,title FROM chat_threads WHERE id=$1 AND workspace_id=$2 AND created_by=$3 AND status='active'`,
      [threadId, request.user.workspaceId, request.user.sub],
    )).rows[0];
    if (!thread) return reply.code(404).send({ error: 'CHAT_THREAD_NOT_FOUND' });
    const attachmentIds = [...new Set(input.attachmentIds)];
    if (attachmentIds.length) {
      const available = await query(
        `SELECT id FROM files WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND status='ready'`,
        [request.user.workspaceId, attachmentIds],
      );
      if (available.rowCount !== attachmentIds.length) return reply.code(409).send({ error: 'CHAT_ATTACHMENTS_NOT_READY_OR_SCOPED' });
    }

    const client = await db.connect();
    let userMessage: Record<string, unknown>;
    try {
      await client.query('BEGIN');
      userMessage = (await client.query(
        `INSERT INTO chat_messages(workspace_id,thread_id,role,content) VALUES($1,$2,'user',$3) RETURNING *`,
        [request.user.workspaceId, thread.id, input.content],
      )).rows[0];
      if (attachmentIds.length) {
        await client.query(
          `INSERT INTO chat_message_attachments(message_id,file_id,workspace_id)
           SELECT $1,id,$2 FROM files WHERE workspace_id=$2 AND id=ANY($3::uuid[]) ON CONFLICT DO NOTHING`,
          [userMessage.id, request.user.workspaceId, attachmentIds],
        );
      }
      const title = thread.title === 'New conversation' ? input.content.replace(/\s+/g, ' ').slice(0, 80) : thread.title;
      await client.query('UPDATE chat_threads SET title=$1,updated_at=now() WHERE id=$2', [title, thread.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const userMessageId = String(userMessage.id);

    const history = await query<{ role: 'user' | 'assistant'; content: string }>(
      `SELECT role,content FROM chat_messages WHERE thread_id=$1 AND workspace_id=$2
       ORDER BY created_at DESC,id DESC LIMIT 20`,
      [thread.id, request.user.workspaceId],
    );
    const messages = history.rows.reverse() as WoodyChatMessage[];
    const attachmentContext = await retrieveChatAttachmentContext(request.user.workspaceId, thread.id, input.content);
    const activeContext = (await query<{ id: string }>(
      `SELECT id FROM copilot_context_snapshots
        WHERE thread_id=$1 AND workspace_id=$2 AND actor_id=$3
        ORDER BY captured_at DESC,id DESC LIMIT 1`,
      [thread.id, request.user.workspaceId, request.user.sub],
    )).rows[0];
    const orchestration = activeContext
      ? await orchestrateCopilotTurn({
        workspaceId: request.user.workspaceId,
        actorId: request.user.sub,
        threadId: thread.id,
        messages,
        attachmentContext: attachmentContext.text,
      })
      : null;
    const answer = orchestration
      ? {
        message: orchestration.content,
        provider: null,
        model: null,
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      }
      : await answerWoody(request.user.workspaceId, messages, attachmentContext.text);
    const metadata = {
      citations: attachmentContext.citations.map(({ content: _content, ...citation }) => citation),
      inReplyToUserMessageId: userMessageId,
      ...(orchestration ? { event: orchestration.event } : {}),
    };
    const assistant = (await query(
      `INSERT INTO chat_messages(
        workspace_id,thread_id,role,content,provider,model,token_input,token_output,estimated_cost_usd,metadata,
        context_snapshot_id,proposal_id
      ) VALUES($1,$2,'assistant',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        request.user.workspaceId, thread.id, answer.message, answer.provider, answer.model,
        answer.usage.inputTokens, answer.usage.outputTokens, answer.usage.estimatedCostUsd,
        JSON.stringify(metadata),
        orchestration?.contextSnapshotId ?? null,
        orchestration?.proposalId ?? null,
      ],
    )).rows[0];
    await query('UPDATE chat_threads SET updated_at=now() WHERE id=$1', [thread.id]);
    await audit(request.user.workspaceId, request.user.sub, 'chat.message_created', 'chat_thread', thread.id, {
      attachmentIds,
      citationCount: attachmentContext.citations.length,
      contextSnapshotId: orchestration?.contextSnapshotId ?? null,
      proposalId: orchestration?.proposalId ?? null,
    });
    request.log.info({
      requestId: request.id,
      graphTraceId: orchestration?.traceId,
      threadId: thread.id,
      contextSnapshotId: orchestration?.contextSnapshotId,
      proposalId: orchestration?.proposalId,
      path: orchestration?.path,
      eventType: orchestration?.event.type,
      repairAttempted: orchestration?.repairAttempted,
      repairSucceeded: orchestration?.repairSucceeded,
    }, 'Copilot message persisted');
    return reply.code(201).send({
      user: { ...userMessage, attachments: attachmentIds },
      assistant: { ...assistant, ...(orchestration ? { event: orchestration.event } : {}) },
      citations: attachmentContext.citations.map(({ content: _content, ...citation }) => citation),
    });
  }));

  app.post('/threads/:id/context', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(contextInput, request.body, reply); if (!input) return;
    const threadId = (request.params as { id: string }).id;
    const context = await resolveCopilotContext({
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
      threadId,
      request: input,
    });
    request.log.info({
      requestId: request.id,
      threadId,
      contextSnapshotId: context.id,
    }, 'Copilot context attached');
    return reply.code(201).send(contextView(context));
  }));

  app.delete('/threads/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const result = await query(
      `DELETE FROM chat_threads WHERE id=$1 AND workspace_id=$2 AND created_by=$3 RETURNING id`,
      [(request.params as { id: string }).id, request.user.workspaceId, request.user.sub],
    );
    return result.rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'CHAT_THREAD_NOT_FOUND' });
  }));
}
