import { McpError } from '../errors.js';
import type { McpTransportAdapter } from './adapter.js';
import { StreamableHttpAdapter } from './streamable-http.js';

const adapters = new Map<string, McpTransportAdapter>([
  ['streamable-http', new StreamableHttpAdapter()],
]);

export function mcpTransport(type: string) {
  const adapter = adapters.get(type);
  if (!adapter) throw new McpError('MCP_TRANSPORT_UNSUPPORTED', `The ${type} transport is not supported yet`, 422);
  return adapter;
}
