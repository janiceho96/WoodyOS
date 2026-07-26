import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import jwt from '@fastify/jwt';
import { db } from './db/client.js';
import { authPlugin } from './auth/plugin.js';
import { registerOidc } from './auth/oidc.js';
import { authRoutes } from './routes/auth.js';
import { agentRoutes } from './routes/agents.js';
import { taskRoutes } from './routes/tasks.js';
import { workflowRoutes } from './routes/workflows.js';
import { memoryRoutes } from './routes/memories.js';
import { toolRoutes } from './routes/tools.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { analyticsRoutes } from './routes/analytics.js';
import { auditRoutes } from './routes/audit.js';
import { teamRoutes } from './routes/teams.js';
import { promptRoutes } from './routes/prompts.js';
import { runtimeRoutes } from './routes/runtime.js';
import { mcpRoutes } from './routes/mcp/index.js';
import { starterSolutionRoutes } from './routes/starter-solutions.js';
import { agentSolutionRoutes } from './routes/agent-solutions.js';
import { usageRoutes } from './routes/usage.js';
import { copilotRoutes } from './routes/copilot.js';
import { artifactRoutes } from './routes/artifacts.js';
import { presentationThemeRoutes } from './routes/presentation-themes.js';
import { workflowNodeRoutes } from './routes/workflow-nodes.js';
import { workflowResourceRoutes } from './routes/workflow-resources.js';
import { workflowActionRoutes } from './routes/workflow-actions.js';
import { actionAuthorizationRoutes } from './routes/action-authorizations.js';
import { fileRoutes } from './routes/files.js';
import { chatThreadRoutes } from './routes/chat-threads.js';
import { artifactTemplateRoutes } from './routes/artifact-templates.js';
import { outputDocumentRoutes } from './routes/output-documents.js';

export async function buildApp() {
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET must be configured in production');
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  await app.register(swagger, { openapi: { info: { title: 'Woody API', version: '0.1.0' }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } } } });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'development-only-change-me-32-chars' });
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const errorCode = statusCode === 500 ? 'INTERNAL_ERROR' : statusCode === 401 ? 'UNAUTHORIZED' : statusCode === 403 ? 'FORBIDDEN' : (error as Error).message;
    reply.code(statusCode).send({
      error: errorCode,
      ...(process.env.NODE_ENV === 'test' && statusCode >= 500 ? { detail: error instanceof Error ? error.message : String(error) } : {}),
    });
  });
  await authPlugin(app);
  await registerOidc(app);
  app.get('/health', async () => { await db.query('SELECT 1'); return { status: 'ok' }; });
  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(agentRoutes, { prefix: '/v1/agents' });
  await app.register(taskRoutes, { prefix: '/v1/tasks' });
  await app.register(workflowRoutes, { prefix: '/v1/workflows' });
  await app.register(memoryRoutes, { prefix: '/v1/memories' });
  await app.register(toolRoutes, { prefix: '/v1/tools' });
  await app.register(knowledgeRoutes, { prefix: '/v1/knowledge' });
  await app.register(analyticsRoutes, { prefix: '/v1/analytics' });
  await app.register(auditRoutes, { prefix: '/v1/audit-events' });
  await app.register(teamRoutes, { prefix: '/v1/teams' });
  await app.register(promptRoutes, { prefix: '/v1/prompts' });
  await app.register(runtimeRoutes, { prefix: '/v1/runtime' });
  await app.register(mcpRoutes, { prefix: '/v1/mcp' });
  await app.register(starterSolutionRoutes, { prefix: '/v1/starter-solutions' });
  await app.register(agentSolutionRoutes, { prefix: '/v1/agent-solutions' });
  await app.register(usageRoutes, { prefix: '/v1/usage' });
  await app.register(copilotRoutes, { prefix: '/v1/copilot' });
  await app.register(artifactRoutes, { prefix: '/v1/artifacts' });
  await app.register(presentationThemeRoutes, { prefix: '/v1/presentation-themes' });
  await app.register(workflowNodeRoutes, { prefix: '/v1/workflow-nodes' });
  await app.register(workflowResourceRoutes, { prefix: '/v1/workflow-resources' });
  await app.register(workflowActionRoutes, { prefix: '/v1/workflow-actions' });
  await app.register(actionAuthorizationRoutes, { prefix: '/v1/action-authorizations' });
  await app.register(fileRoutes, { prefix: '/v1/files' });
  await app.register(chatThreadRoutes, { prefix: '/v1/copilot' });
  await app.register(artifactTemplateRoutes, { prefix: '/v1/artifact-templates' });
  await app.register(outputDocumentRoutes, { prefix: '/v1/output-documents' });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = await buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' });
}
