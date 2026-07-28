import { lookup } from 'node:dns/promises';
import { decryptJson } from '../lib/crypto.js';
import { isPublicIp } from '../lib/network.js';
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
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
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

function toolHttpError(response: Response) {
  const message = `Tool request failed with HTTP ${response.status}`;
  if (response.status === 429) {
    const retryAfter = retryAfterMs(response.headers.get('retry-after'));
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
  if (error instanceof WorkflowRuntimeError) return error;
  if (callerSignal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return cancellationError(error);
  if (timeoutSignal.aborted || (error instanceof DOMException && error.name === 'TimeoutError')) {
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

function toolEndpointError(error: unknown, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal) {
  const message = error instanceof Error ? error.message : '';
  if (
    message === 'Tool endpoints must use HTTPS'
    || message === 'Non-public tool endpoints are not allowed'
    || (error instanceof TypeError && !('code' in error))
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
  let response: Response;
  try {
    if (healthCheck) {
      response = await fetch(endpoint, { method: 'GET', signal: timeout, headers });
    } else if (tool.kind === 'mcp') {
      response = await fetch(endpoint, { method: 'POST', signal: timeout, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name: String(config.mcpToolName ?? tool.name), arguments: input } }) });
    } else {
      const method = String(config.method ?? 'POST').toUpperCase();
      if (!['GET', 'POST'].includes(method)) throw runtimeError('TOOL_METHOD_INVALID', {
        category: 'validation',
        retryable: false,
        message: 'Tool method configuration is invalid',
      });
      if (method === 'GET') Object.entries(input).forEach(([key, value]) => endpoint.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value)));
      response = await fetch(endpoint, { method, signal: timeout, headers: method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers, body: method === 'POST' ? JSON.stringify(input) : undefined });
    }
  } catch (error) {
    throw toolTransportError(error, callerSignal, timeoutSignal);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw toolHttpError(response);
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw toolTransportError(error, callerSignal, timeoutSignal);
  }
  const limited = body.slice(0, 50_000);
  try { return JSON.parse(limited) as unknown; } catch { return { text: limited }; }
}
