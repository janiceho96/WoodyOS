import type { authorizeWorkflowAction } from '../../policy/action-gateway.js';

type AuthorizationResult = Awaited<ReturnType<typeof authorizeWorkflowAction>>;

export function completedAuthorizationResult(
  authorization: AuthorizationResult,
  setNodeOutput: (value: unknown) => void,
) {
  if (authorization.status === 'denied') {
    throw Object.assign(new Error(authorization.reason), { retryable: false });
  }
  if (authorization.status !== 'completed') return null;
  setNodeOutput(authorization.result);
  return { output: authorization.result, result: authorization.result };
}

export function allowedAuthorizationId(authorization: AuthorizationResult) {
  if (authorization.status !== 'allowed') {
    throw Object.assign(new Error('Action authorization did not allow execution'), { retryable: false });
  }
  return authorization.authorizationId;
}
