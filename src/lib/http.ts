import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';

const safeCode = /^[A-Z][A-Z0-9_.-]{1,120}$/;

export function publicErrorCode(error: unknown, statusCode: number) {
  if (statusCode === 500) return 'INTERNAL_ERROR';
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'McpError') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.slice(0, 500);
  }
  const message = error instanceof Error ? error.message : '';
  return safeCode.test(message) ? message : statusCode === 401 ? 'UNAUTHORIZED' : statusCode === 403 ? 'FORBIDDEN' : 'REQUEST_FAILED';
}

export function parse<T>(schema: ZodType<T>, value: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  reply.header('x-request-id', reply.request.id).code(400).send({
    error: 'VALIDATION_ERROR',
    details: result.error.flatten(),
    requestId: reply.request.id,
  });
  return undefined;
}

export function asyncRoute<T extends FastifyRequest>(handler: (request: T, reply: FastifyReply) => Promise<unknown>) {
  return async (request: T, reply: FastifyReply) => {
    try { return await handler(request, reply); }
    catch (error) {
      const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
      const errorCode = publicErrorCode(error, statusCode);
      request.log.error({ requestId: request.id, statusCode, errorCode }, 'Request failed');
      return reply.header('x-request-id', request.id).code(statusCode).send({ error: errorCode, requestId: request.id });
    }
  };
}
