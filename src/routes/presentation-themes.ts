import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { themeFromDesignMarkdown } from '../presentations/theme.js';

const themeInput = z.object({ name: z.string().min(2).max(120), designMarkdown: z.string().min(20).max(30_000), isDefault: z.boolean().default(true) });
const idInput = z.object({ id: z.string().uuid() });

export async function presentationThemeRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => ({ data: (await query('SELECT id,name,theme,is_default,created_at,updated_at FROM presentation_themes WHERE workspace_id=$1 ORDER BY is_default DESC,updated_at DESC', [request.user.workspaceId])).rows })));
  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const input = parse(themeInput, request.body, reply); if (!input) return;
    const theme = themeFromDesignMarkdown(input.designMarkdown);
    if (input.isDefault) await query('UPDATE presentation_themes SET is_default=false,updated_at=now() WHERE workspace_id=$1 AND is_default=true', [request.user.workspaceId]);
    const result = await query('INSERT INTO presentation_themes(workspace_id,name,design_markdown,theme,is_default,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,theme,is_default,created_at,updated_at', [request.user.workspaceId, input.name, input.designMarkdown, JSON.stringify(theme), input.isDefault, request.user.sub]);
    await audit(request.user.workspaceId, request.user.sub, 'presentation_theme.created', 'presentation_theme', result.rows[0].id, { isDefault: input.isDefault });
    return reply.code(201).send(result.rows[0]);
  }));
  app.patch('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const params = parse(idInput, request.params, reply); const input = parse(themeInput.partial(), request.body, reply); if (!params || !input) return;
    const existing = (await query<{ id: string; design_markdown: string }>('SELECT id,design_markdown FROM presentation_themes WHERE id=$1 AND workspace_id=$2', [params.id, request.user.workspaceId])).rows[0];
    if (!existing) return reply.code(404).send({ error: 'PRESENTATION_THEME_NOT_FOUND' });
    const markdown = input.designMarkdown ?? existing.design_markdown;
    if (input.isDefault) await query('UPDATE presentation_themes SET is_default=false,updated_at=now() WHERE workspace_id=$1 AND is_default=true AND id<>$2', [request.user.workspaceId, params.id]);
    const result = await query('UPDATE presentation_themes SET name=COALESCE($1,name),design_markdown=$2,theme=$3,is_default=COALESCE($4,is_default),updated_at=now() WHERE id=$5 AND workspace_id=$6 RETURNING id,name,theme,is_default,created_at,updated_at', [input.name ?? null, markdown, JSON.stringify(themeFromDesignMarkdown(markdown)), input.isDefault ?? null, params.id, request.user.workspaceId]);
    return result.rows[0];
  }));
  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const params = parse(idInput, request.params, reply); if (!params) return;
    const result = await query('DELETE FROM presentation_themes WHERE id=$1 AND workspace_id=$2 RETURNING id', [params.id, request.user.workspaceId]);
    return result.rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'PRESENTATION_THEME_NOT_FOUND' });
  }));
}
