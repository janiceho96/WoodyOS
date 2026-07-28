import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asyncRoute, parse } from '../lib/http.js';
import {
  confirmMemory,
  createMemory,
  deleteMemory,
  disputeMemory,
  expireMemory,
  listEligibleMemories,
  listManagedMemories,
  serializeMemory,
  supersedeMemory,
  updateMemory,
} from '../memories/service.js';

const memoryTypes = ['preference', 'fact', 'decision', 'project_context', 'workflow_result', 'error_resolution', 'summary', 'hypothesis'] as const;
const scopes = ['workspace', 'agent', 'user'] as const;
const verificationStatuses = ['user_confirmed', 'agent_inferred', 'system_generated', 'unverified'] as const;
const managementVerificationStatuses = [...verificationStatuses, 'disputed', 'superseded'] as const;
const legacyKinds = ['conversation', 'knowledge', 'user'] as const;

const sourceInput = z.object({ type: z.string().min(1).max(100), id: z.string().max(200).nullable().optional() });
const memoryFields = z.object({
  agentId: z.string().uuid().nullable().optional(),
  kind: z.enum(legacyKinds).optional(),
  type: z.enum(memoryTypes).optional(),
  scope: z.enum(scopes).optional(),
  content: z.string().min(1).max(50000),
  importance: z.number().min(0).max(1).default(0.5),
  metadata: z.record(z.unknown()).default({}),
  source: sourceInput.optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  verificationStatus: z.enum(verificationStatuses).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});
const createInput = memoryFields.refine((value) => Boolean(value.kind || value.type), { message: 'kind or type is required' });

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  agentId: z.string().uuid().optional(),
  type: z.enum(memoryTypes).optional(),
  scope: z.enum(scopes).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const managementListQuery = z.object({
  agentId: z.string().uuid().optional(),
  type: z.enum(memoryTypes).optional(),
  scope: z.enum(scopes).optional(),
  verificationStatus: z.enum(managementVerificationStatuses).optional(),
  expiry: z.enum(['active', 'expired', 'any']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1000).optional(),
});
const updateInput = z.object({
  content: z.string().min(1).max(50000).optional(),
  importance: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).optional(),
  scope: z.enum(scopes).optional(),
  agentId: z.string().uuid().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
}).superRefine((value, context) => {
  if (value.expiresAt && value.expiresAt <= new Date()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiresAt must be in the future or null' });
  }
});

const supersedeInput = z.object({
  replacementMemoryId: z.string().uuid().optional(),
  replacement: createInput.optional(),
}).refine((value) => Boolean(value.replacementMemoryId || value.replacement), { message: 'replacementMemoryId or replacement is required' });

export async function memoryRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const filters = parse(listQuery, request.query, reply); if (!filters) return;
    const memories = await listEligibleMemories({ workspaceId: request.user.workspaceId, ...filters });
    return { data: memories.map(serializeMemory) };
  }));

  app.get('/manage', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const filters = parse(managementListQuery, request.query, reply); if (!filters) return;
    const result = await listManagedMemories({ workspaceId: request.user.workspaceId, ...filters });
    return { data: result.memories.map(serializeMemory), pagination: result.pagination };
  }));

  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(createInput, request.body, reply); if (!input) return;
    const memory = await createMemory({ ...input, workspaceId: request.user.workspaceId, userId: request.user.sub, actor: { type: 'user', id: request.user.sub } });
    return reply.code(201).send(serializeMemory(memory));
  }));

  app.post('/:id/confirm', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply); if (!params) return;
    return serializeMemory(await confirmMemory({ workspaceId: request.user.workspaceId, memoryId: params.id, actorId: request.user.sub }));
  }));

  app.post('/:id/dispute', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply); if (!params) return;
    return serializeMemory(await disputeMemory({ workspaceId: request.user.workspaceId, memoryId: params.id, actorId: request.user.sub }));
  }));

  app.post('/:id/expire', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply); if (!params) return;
    return serializeMemory(await expireMemory({ workspaceId: request.user.workspaceId, memoryId: params.id }));
  }));

  app.post('/:id/supersede', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply); if (!params) return;
    const input = parse(supersedeInput, request.body, reply); if (!input) return;
    const result = await supersedeMemory({
      workspaceId: request.user.workspaceId,
      memoryId: params.id,
      replacementMemoryId: input.replacementMemoryId,
      replacement: input.replacement && { ...input.replacement, userId: request.user.sub, actor: { type: 'user', id: request.user.sub } },
    });
    return { memory: serializeMemory(result.memory), replacement: serializeMemory(result.replacement) };
  }));

  app.patch('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply); if (!params) return;
    const input = parse(updateInput, request.body, reply); if (!input) return;
    return serializeMemory(await updateMemory({
      workspaceId: request.user.workspaceId,
      memoryId: params.id,
      actorId: request.user.sub,
      ...input,
    }));
  }));

  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply); if (!params) return;
    await deleteMemory({ workspaceId: request.user.workspaceId, memoryId: params.id });
    return reply.code(204).send();
  }));
}
