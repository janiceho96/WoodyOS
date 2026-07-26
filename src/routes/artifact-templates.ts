import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { htmlThemeFromDesignMarkdown } from '../artifacts/template.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';

const templateInput = z.object({
  name: z.string().trim().min(2).max(120),
  format: z.literal('html').default('html'),
  designMarkdown: z.string().min(20).max(30_000),
  isDefault: z.boolean().default(true),
});
const idInput = z.object({ id: z.string().uuid() });

export async function artifactTemplateRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => ({
    data: (await query(
      `SELECT id,name,format,theme,is_default,created_at,updated_at
       FROM artifact_templates WHERE workspace_id=$1
       ORDER BY format,is_default DESC,updated_at DESC`,
      [request.user.workspaceId],
    )).rows,
  })));

  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const input = parse(templateInput, request.body, reply); if (!input) return;
    if (input.isDefault) {
      await query(
        'UPDATE artifact_templates SET is_default=false,updated_at=now() WHERE workspace_id=$1 AND format=$2 AND is_default=true',
        [request.user.workspaceId, input.format],
      );
    }
    const result = (await query(
      `INSERT INTO artifact_templates(workspace_id,name,format,design_markdown,theme,is_default,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,name,format,theme,is_default,created_at,updated_at`,
      [
        request.user.workspaceId, input.name, input.format, input.designMarkdown,
        JSON.stringify(htmlThemeFromDesignMarkdown(input.designMarkdown)), input.isDefault, request.user.sub,
      ],
    )).rows[0];
    await audit(request.user.workspaceId, request.user.sub, 'artifact_template.created', 'artifact_template', result.id, {
      format: input.format, isDefault: input.isDefault,
    });
    return reply.code(201).send(result);
  }));

  app.patch('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const params = parse(idInput, request.params, reply);
    const input = parse(templateInput.partial(), request.body, reply);
    if (!params || !input) return;
    const existing = (await query<{ id: string; format: 'html'; design_markdown: string }>(
      'SELECT id,format,design_markdown FROM artifact_templates WHERE id=$1 AND workspace_id=$2',
      [params.id, request.user.workspaceId],
    )).rows[0];
    if (!existing) return reply.code(404).send({ error: 'ARTIFACT_TEMPLATE_NOT_FOUND' });
    const format = input.format ?? existing.format;
    const markdown = input.designMarkdown ?? existing.design_markdown;
    if (input.isDefault) {
      await query(
        'UPDATE artifact_templates SET is_default=false,updated_at=now() WHERE workspace_id=$1 AND format=$2 AND id<>$3 AND is_default=true',
        [request.user.workspaceId, format, params.id],
      );
    }
    return (await query(
      `UPDATE artifact_templates
       SET name=COALESCE($1,name),format=$2,design_markdown=$3,theme=$4,
           is_default=COALESCE($5,is_default),updated_at=now()
       WHERE id=$6 AND workspace_id=$7
       RETURNING id,name,format,theme,is_default,created_at,updated_at`,
      [
        input.name ?? null, format, markdown, JSON.stringify(htmlThemeFromDesignMarkdown(markdown)),
        input.isDefault ?? null, params.id, request.user.workspaceId,
      ],
    )).rows[0];
  }));

  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const params = parse(idInput, request.params, reply); if (!params) return;
    const result = await query(
      'DELETE FROM artifact_templates WHERE id=$1 AND workspace_id=$2 RETURNING id',
      [params.id, request.user.workspaceId],
    );
    return result.rowCount
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'ARTIFACT_TEMPLATE_NOT_FOUND' });
  }));
}
