import { lookup } from 'node:dns/promises';
import { decryptJson } from '../lib/crypto.js';
import { isPublicIp } from '../lib/network.js';
import { safeHttpRequest } from './web/http.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { invokeJobTool, isJobToolConfig } from './jobs/index.js';
import { invokeWebTool, isWebToolConfig } from './web/index.js';
import { cancellationError, combineAbortSignals } from '../runtime/cancellation.js';
import { WorkflowRuntimeError, runtimeError } from '../runtime/errors.js';

export type StoredConfig = { version: 1; iv: string; tag: string; data: string };
export type ToolRecord = { id: string; name: string; kind: 'mcp' | 'api' | 'plugin' | 'internal'; config: StoredConfig; permissions: string[] };
export type ToolRiskLevel = 'read' | 'write' | 'external_write' | 'destructive' | 'unknown';

const toolRequestTimeoutMs = 20_000;
const maxRetryAfterMs = 60_000;

export function toolRequiresApproval(tool: ToolRecord) {
  const permissionSignals = tool.permissions.join(' ').toLowerCase();
  if (/(^|[\s._:-])(write|create|update|delete|remove|send|upload|publish|destructive|external_write)([\s._:-]|$)/.test(permissionSignals)) return true;
  try {
    const config = decryptJson(tool.config);
    if (config.readOnly === true) return false;
    return String(config.method ?? 'POST').toUpperCase() !== 'GET';
  } catch {
    return true;
  }
}

export function toolRiskLevel(tool: ToolRecord): ToolRiskLevel {
  const signals = tool.permissions.join(' ').toLowerCase();
  if (/(^|[\s._:-])(delete|remove|destroy|purge)([\s._:-]|$)/.test(signals)) return 'destructive';
  if (/(^|[\s._:-])(send|publish|message|email|external_write)([\s._:-]|$)/.test(signals)) return 'external_write';
  try {
    const config = decryptJson(tool.config);
    if (config.readOnly === true || String(config.method ?? 'POST').toUpperCase() === 'GET') return 'read';
    return 'write';
  } catch {
    return 'unknown';
  }
}

export async function safeEndpoint(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('Tool endpoints must use HTTPS');
  if (url.username || url.password) throw new Error('Tool endpoint credentials must be sent with headers');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('Tool endpoint hostname could not be resolved');
  for (const { address } of addresses) {
    if (!isPublicIp(address)) throw new Error('Non-public tool endpoints are not allowed');
  }
  return url;
}

function headersFrom(value: unknown) {
  return Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function retryAfterMs(value: string | null) {
  if (!value) return undefined;
  if (/^\s*\d+\s*$/.test(value)) {
    return Math.min(maxRetryAfterMs, Number(value.trim()) * 1_000);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(maxRetryAfterMs, Math.max(0, timestamp - Date.now()));
}

function toolHttpError(response: { status: number; headers: Record<string, string> }) {
  const message = `Tool request failed with HTTP ${response.status}`;
  if (response.status === 429) {
    const retryAfter = retryAfterMs(response.headers['retry-after'] ?? null);
    return runtimeError('TOOL_RATE_LIMITED', {
      category: 'rate_limited',
      retryable: true,
      message,
      ...(retryAfter === undefined ? {} : { details: { retryAfterMs: retryAfter } }),
    });
  }
  if ([408, 425, 500, 502, 503, 504].includes(response.status)) {
    return runtimeError('TOOL_HTTP_TRANSIENT', { category: 'transient', retryable: true, message });
  }
  if ([401, 403].includes(response.status)) {
    return runtimeError('TOOL_AUTHENTICATION_FAILED', { category: 'authentication', retryable: false, message });
  }
  return runtimeError('TOOL_HTTP_VALIDATION_FAILED', { category: 'validation', retryable: false, message });
}

function toolTransportError(error: unknown, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal) {
  if (callerSignal?.aborted) return cancellationError(error);
  if (timeoutSignal.aborted) {
    return runtimeError('TOOL_TIMEOUT', {
      category: 'timeout',
      retryable: true,
      message: 'Tool request timed out',
      cause: error,
    });
  }
  if (error instanceof WorkflowRuntimeError) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return runtimeError('TOOL_TIMEOUT', {
      category: 'timeout',
      retryable: true,
      message: 'Tool request timed out',
      cause: error,
    });
  }
  return runtimeError('TOOL_TRANSPORT_FAILURE', {
    category: 'transient',
    retryable: true,
    message: 'Tool endpoint could not be reached',
    cause: error,
  });
}

function toolRequestError(error: unknown) {
  if (error instanceof WorkflowRuntimeError) return error;
  return runtimeError('TOOL_REQUEST_INVALID', {
    category: 'validation',
    retryable: false,
    message: 'Tool request could not be constructed from the supplied input',
    cause: error,
  });
}

function toolEndpointError(error: unknown, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal) {
  if (callerSignal?.aborted || timeoutSignal.aborted) {
    return toolTransportError(error, callerSignal, timeoutSignal);
  }
  const message = error instanceof Error ? error.message : '';
  if (
    message === 'Tool endpoints must use HTTPS'
    || message === 'Non-public tool endpoints are not allowed'
    || message === 'Tool endpoint credentials must be sent with headers'
    || message === 'Tool endpoint hostname could not be resolved'
    || /private, local, and reserved|hostname resolves to a private|Only HTTPS addresses|Credentials are not allowed inside URLs|Cross-origin redirects are blocked|External redirect was blocked|Credential-bearing cross-origin redirects are blocked/i.test(message)
    || (
      error instanceof TypeError
      && 'code' in error
      && error.code === 'ERR_INVALID_URL'
    )
  ) {
    return runtimeError('TOOL_ENDPOINT_INVALID', {
      category: 'validation',
      retryable: false,
      message: 'Tool endpoint configuration is invalid',
      cause: error,
    });
  }
  return toolTransportError(error, callerSignal, timeoutSignal);
}

export function definitionFor(tool: ToolRecord): Tool {
  const config = decryptJson(tool.config);
  const suppliedSchema = config.inputSchema && typeof config.inputSchema === 'object' ? config.inputSchema as Record<string, unknown> : undefined;
  const inputSchema = suppliedSchema?.type === 'object' ? suppliedSchema : { type: 'object', properties: {}, additionalProperties: true };
  return { name: `tool_${tool.id.replaceAll('-', '_')}`, description: String(config.agentDescription ?? tool.name), input_schema: inputSchema as Tool['input_schema'] };
}

type PreparedToolRequest = { endpoint: URL; init: RequestInit; timeoutSignal: AbortSignal };

function toolRequestInit(tool: ToolRecord, config: Record<string, unknown>, input: Record<string, unknown>, healthCheck: boolean, timeout: AbortSignal, endpoint: URL, headers: Record<string, string>): RequestInit {
  if (healthCheck) return { method: 'GET', signal: timeout, headers };
  if (tool.kind === 'mcp') {
    return {
      method: 'POST',
      signal: timeout,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: { name: String(config.mcpToolName ?? tool.name), arguments: input },
      }),
    };
  }
  const method = String(config.method ?? 'POST').toUpperCase();
  if (!['GET', 'POST'].includes(method)) {
    throw runtimeError('TOOL_METHOD_INVALID', {
      category: 'validation',
      retryable: false,
      message: 'Tool method configuration is invalid',
    });
  }
  if (method === 'GET') {
    Object.entries(input).forEach(([key, value]) => endpoint.searchParams.set(
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ));
  }
  return {
    method,
    signal: timeout,
    headers: method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers,
    body: method === 'POST' ? JSON.stringify(input) : undefined,
  };
}

async function prepareToolRequest(tool: ToolRecord, config: Record<string, unknown>, input: Record<string, unknown>, healthCheck: boolean, callerSignal?: AbortSignal): Promise<PreparedToolRequest> {
  const healthUrl = config.healthCheckUrl;
  if (healthCheck && typeof healthUrl !== 'string') throw new Error('A healthCheckUrl is required to test this tool safely');
  const timeoutSignal = AbortSignal.timeout(toolRequestTimeoutMs);
  let endpoint: URL;
  try {
    endpoint = await safeEndpoint(String(healthCheck ? healthUrl : config.endpoint ?? ''));
  } catch (error) {
    throw toolEndpointError(error, callerSignal, timeoutSignal);
  }
  const headers = headersFrom(config.headers);
  const timeout = combineAbortSignals([callerSignal, timeoutSignal]);
  try {
    const init = toolRequestInit(tool, config, input, healthCheck, timeout, endpoint, headers);
    // Construct once before dispatch so invalid headers/body/options cannot be mistaken for transport failure.
    void new Request(endpoint, init);
    return { endpoint, init, timeoutSignal };
  } catch (error) {
    throw toolRequestError(error);
  }
}

function parseToolResponse(body: string) {
  const limited = body.slice(0, 50_000);
  try { return JSON.parse(limited) as unknown; }
  catch { return { text: limited }; }
}

export async function invokeTool(
  tool: ToolRecord,
  input: Record<string, unknown>,
  healthCheck = false,
  callerSignal?: AbortSignal,
) {
  if (callerSignal?.aborted) throw cancellationError(callerSignal.reason);
  const config = decryptJson(tool.config);
  if (isWebToolConfig(config)) return invokeWebTool(config, input, healthCheck, callerSignal);
  if (isJobToolConfig(config)) return invokeJobTool(config, input, healthCheck, callerSignal);
  const request = await prepareToolRequest(tool, config, input, healthCheck, callerSignal);
  let response: Awaited<ReturnType<typeof safeHttpRequest>>;
  try {
    response = await safeHttpRequest(request.endpoint.toString(), {
      method: request.init.method as 'GET' | 'POST',
      headers: Object.fromEntries(new Headers(request.init.headers).entries()),
      ...(typeof request.init.body === 'string' ? { body: request.init.body } : {}),
      signal: request.init.signal ?? undefined,
      timeoutMs: toolRequestTimeoutMs,
      maxBytes: 5_000_000,
      maxRedirects: 3,
    });
  } catch (error) {
    throw toolEndpointError(error, callerSignal, request.timeoutSignal);
  }
  if (response.status < 200 || response.status >= 300) throw toolHttpError(response);
  return parseToolResponse(response.body.toString('utf8'));
}
