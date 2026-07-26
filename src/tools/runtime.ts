import { lookup } from 'node:dns/promises';
import { decryptJson } from '../lib/crypto.js';
import { isPublicIp } from '../lib/network.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { invokeJobTool, isJobToolConfig } from './jobs/index.js';
import { invokeWebTool, isWebToolConfig } from './web/index.js';
import { combinedAbortSignal } from '../runtime/cancellation.js';

export type StoredConfig = { version: 1; iv: string; tag: string; data: string };
export type ToolRecord = { id: string; name: string; kind: 'mcp' | 'api' | 'plugin' | 'internal'; config: StoredConfig; permissions: string[] };
export type ToolRiskLevel = 'read' | 'write' | 'external_write' | 'destructive' | 'unknown';

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
  const config = decryptJson(tool.config);
  if (isWebToolConfig(config)) return invokeWebTool(config, input, healthCheck, callerSignal);
  if (isJobToolConfig(config)) return invokeJobTool(config, input, healthCheck, callerSignal);
  const healthUrl = config.healthCheckUrl;
  if (healthCheck && typeof healthUrl !== 'string') throw new Error('A healthCheckUrl is required to test this tool safely');
  const endpoint = await safeEndpoint(String(healthCheck ? healthUrl : config.endpoint ?? ''));
  const headers = headersFrom(config.headers);
  const timeout = combinedAbortSignal(callerSignal, 20_000);
  let response: Response;
  if (healthCheck) {
    response = await fetch(endpoint, { method: 'GET', signal: timeout, headers });
  } else if (tool.kind === 'mcp') {
    response = await fetch(endpoint, { method: 'POST', signal: timeout, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name: String(config.mcpToolName ?? tool.name), arguments: input } }) });
  } else {
    const method = String(config.method ?? 'POST').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new Error('Only GET and POST API tools are allowed');
    if (method === 'GET') Object.entries(input).forEach(([key, value]) => endpoint.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value)));
    response = await fetch(endpoint, { method, signal: timeout, headers: method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers, body: method === 'POST' ? JSON.stringify(input) : undefined });
  }
  const body = await response.text();
  const limited = body.slice(0, 50_000);
  if (!response.ok) throw new Error(`Tool request failed with ${response.status}: ${limited.slice(0, 500)}`);
  try { return JSON.parse(limited) as unknown; } catch { return { text: limited }; }
}
