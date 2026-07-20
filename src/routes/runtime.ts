import type { FastifyInstance } from 'fastify';
import { configuredAiProvider } from '../lib/ai-provider.js';

function publicRuntimeConfig() {
  const runtime = configuredAiProvider();
  return {
    provider: runtime.provider,
    defaultModel: runtime.defaultModel,
  };
}

export async function runtimeRoutes(app: FastifyInstance) {
  app.get('/config', { preHandler: app.authenticate }, async () => publicRuntimeConfig());
}
