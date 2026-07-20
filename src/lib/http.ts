import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';

export function parse<T>(schema: ZodType<T>, value: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  reply.code(400).send({ error: 'VALIDATION_ERROR', details: result.error.flatten() });
  return undefined;
}

export function asyncRoute<T extends FastifyRequest>(handler: (request: T, reply: FastifyReply) => Promise<unknown>) {
  return async (request: T, reply: FastifyReply) => {
    try { return await handler(request, reply); }
    catch (error) {
      request.log.error(error);
      const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
      return reply.code(statusCode).send({ error: statusCode === 500 ? 'INTERNAL_ERROR' : (error instanceof Error ? error.message : 'REQUEST_FAILED') });
    }
  };
}
