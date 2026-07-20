import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { encryptJson } from '../lib/crypto.js';
import { invokeTool, type StoredConfig } from '../tools/runtime.js';
const inputSchema = z.object({ name: z.string().min(2).max(100), kind: z.enum(['mcp', 'api', 'plugin', 'internal']), description: z.string().max(2000).default(''), config: z.record(z.unknown()).default({}), permissions: z.array(z.string().min(1)).default([]), enabled: z.boolean().default(true) });

export function toolConfigurationError(kind: z.infer<typeof inputSchema>['kind'] | undefined, config: Record<string, unknown> | undefined) {
  if (!kind || !config || (kind !== 'api' && kind !== 'mcp')) return null;
  for (const field of ['endpoint', 'healthCheckUrl'] as const) {
    const value = config[field];
    if (field === 'healthCheckUrl' && value === undefined) continue;
    if (typeof value !== 'string') return `${field} is required`;
    try {
      if (new URL(value).protocol !== 'https:') return `${field} must use HTTPS`;
    } catch {
      return `${field} must be a valid HTTPS URL`;
    }
  }
  return null;
}

export async function toolRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => ({ data: (await query('SELECT id,name,kind,description,permissions,enabled,created_at,updated_at FROM tools WHERE workspace_id=$1 ORDER BY name', [request.user.workspaceId])).rows })));
  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const input = parse(inputSchema, request.body, reply); if (!input) return;
    const configError = toolConfigurationError(input.kind, input.config);
    if (configError) return reply.code(400).send({ error: 'INVALID_TOOL_CONFIGURATION', detail: configError });
    const result = await query('INSERT INTO tools(workspace_id,name,kind,description,config,permissions,enabled) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,kind,description,permissions,enabled,created_at', [request.user.workspaceId, input.name, input.kind, input.description, JSON.stringify(encryptJson(input.config ?? {})), JSON.stringify(input.permissions), input.enabled]);
    await audit(request.user.workspaceId, request.user.sub, 'tool.created', 'tool', result.rows[0].id);
    return reply.code(201).send(result.rows[0]);
  }));
  app.patch('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const input = parse(inputSchema.partial(), request.body, reply); if (!input) return;
    const existing = await query<{ kind: z.infer<typeof inputSchema>['kind'] }>('SELECT kind FROM tools WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!existing.rowCount) return reply.code(404).send({ error: 'TOOL_NOT_FOUND' });
    const configError = toolConfigurationError(input.kind ?? existing.rows[0].kind, input.config);
    if (configError) return reply.code(400).send({ error: 'INVALID_TOOL_CONFIGURATION', detail: configError });
    const entries: Array<[string, unknown]> = [];
    if (input.name !== undefined) entries.push(['name', input.name]);
    if (input.kind !== undefined) entries.push(['kind', input.kind]);
    if (input.description !== undefined) entries.push(['description', input.description]);
    if (input.config !== undefined) entries.push(['config', JSON.stringify(encryptJson(input.config))]);
    if (input.permissions !== undefined) entries.push(['permissions', JSON.stringify(input.permissions)]);
    if (input.enabled !== undefined) entries.push(['enabled', input.enabled]);
    if (!entries.length) return reply.code(400).send({ error: 'NO_UPDATES' });
    const values = entries.map(([, value]) => value);
    const assignments = entries.map(([field], index) => `${field}=$${index + 1}`).join(', ');
    const result = await query(`UPDATE tools SET ${assignments},updated_at=now() WHERE id=$${values.length + 1} AND workspace_id=$${values.length + 2} RETURNING id,name,kind,description,permissions,enabled,updated_at`, [...values, (request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'TOOL_NOT_FOUND' });
    await audit(request.user.workspaceId, request.user.sub, 'tool.updated', 'tool', result.rows[0].id, { fields: entries.map(([field]) => field) });
    return result.rows[0];
  }));
  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const result = await query('UPDATE tools SET enabled=false,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING id', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'TOOL_NOT_FOUND' });
    await audit(request.user.workspaceId, request.user.sub, 'tool.disabled', 'tool', result.rows[0].id);
    return reply.code(204).send();
  }));
  app.post('/:id/test', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const tool = await query<{ id: string; enabled: boolean; config: StoredConfig }>('SELECT id,enabled,config FROM tools WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!tool.rowCount || !tool.rows[0].enabled) return reply.code(404).send({ error: 'TOOL_NOT_AVAILABLE' });
    let testResult: unknown;
    try { testResult = await invokeTool({ ...tool.rows[0], name: 'health-check', kind: 'api', permissions: [] }, {}, true); }
    catch (error) { return reply.code(502).send({ error: 'TOOL_UNHEALTHY', detail: error instanceof Error ? error.message : 'Tool test failed' }); }
    await audit(request.user.workspaceId, request.user.sub, 'tool.test_requested', 'tool', tool.rows[0].id);
    return { toolId: tool.rows[0].id, status: 'healthy', result: testResult };
  }));
}
