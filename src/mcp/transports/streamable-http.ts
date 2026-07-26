import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '../errors.js';
import { assertSafeMcpEndpoint, createSafeMcpFetch, safeMcpHeaders } from '../network.js';
import { combineAbortSignals, combinedAbortSignal } from '../../runtime/cancellation.js';
import type {
  McpCallResult,
  McpDiscoveredTool,
  McpTransportAdapter,
  McpTransportSession,
} from './adapter.js';

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_DISCOVERED_TOOLS = 1_000;

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class StreamableHttpAdapter implements McpTransportAdapter {
  readonly transport = 'streamable-http';

  constructor(private readonly dependencies: {
    validateEndpoint?: typeof assertSafeMcpEndpoint;
    fetchFactory?: typeof createSafeMcpFetch;
  } = {}) {}

  async connect(input: { endpointUrl: string; headers?: Record<string, string>; authProvider?: import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider; signal?: AbortSignal }): Promise<McpTransportSession> {
    const endpoint = await (this.dependencies.validateEndpoint ?? assertSafeMcpEndpoint)(input.endpointUrl);
    const headers = safeMcpHeaders(input.headers ?? {});
    const safeFetch = (this.dependencies.fetchFactory ?? createSafeMcpFetch)(endpoint);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: (request, init) => safeFetch(request, {
        ...init,
        signal: combineAbortSignals([input.signal, init?.signal]),
      }),
      requestInit: { headers },
      authProvider: input.authProvider,
      reconnectionOptions: {
        maxReconnectionDelay: 5_000,
        initialReconnectionDelay: 500,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 1,
      },
    });
    const client = new Client(
      { name: 'ai-nexus', version: '0.1.0' },
      { capabilities: {} },
    );
    try {
      await client.connect(transport, {
        signal: combinedAbortSignal(input.signal, CONNECT_TIMEOUT_MS),
        timeout: CONNECT_TIMEOUT_MS,
        maxTotalTimeout: CONNECT_TIMEOUT_MS,
      });
    } catch (cause) {
      await transport.close().catch(() => undefined);
      const message = cause instanceof Error ? cause.message : 'MCP initialization failed';
      if (input.authProvider && /(?:unauthorized|unauthorised|\b401\b)/i.test(message)) {
        throw new McpError(
          'MCP_OAUTH_REQUIRED',
          'Authorize this MCP connection before testing or discovering tools',
          401,
          { cause },
        );
      }
      throw new McpError('MCP_INITIALIZE_FAILED', `Could not initialize the MCP server: ${message.slice(0, 300)}`, 502, { cause });
    }
    const info = {
      serverInfo: plainRecord(client.getServerVersion()),
      capabilities: plainRecord(client.getServerCapabilities()),
      instructions: client.getInstructions(),
      sessionId: transport.sessionId,
    };
    return {
      info,
      async ping(signal = input.signal) {
        await client.ping({ signal: combinedAbortSignal(signal, CONNECT_TIMEOUT_MS), timeout: CONNECT_TIMEOUT_MS, maxTotalTimeout: CONNECT_TIMEOUT_MS });
      },
      async listTools(signal = input.signal) {
        const discovered: McpDiscoveredTool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(
            cursor ? { cursor } : undefined,
            { signal: combinedAbortSignal(signal, CONNECT_TIMEOUT_MS), timeout: CONNECT_TIMEOUT_MS, maxTotalTimeout: CONNECT_TIMEOUT_MS },
          );
          for (const tool of page.tools) {
            if (discovered.length >= MAX_DISCOVERED_TOOLS) {
              throw new McpError('MCP_TOOL_LIMIT_EXCEEDED', `MCP servers are limited to ${MAX_DISCOVERED_TOOLS} discovered tools`, 422);
            }
            discovered.push({
              name: tool.name,
              title: tool.title,
              description: (tool.description ?? '').slice(0, 20_000),
              inputSchema: plainRecord(tool.inputSchema),
              outputSchema: tool.outputSchema ? plainRecord(tool.outputSchema) : undefined,
              annotations: plainRecord(tool.annotations),
            });
          }
          cursor = page.nextCursor;
        } while (cursor);
        return discovered;
      },
      async callTool(name, arguments_, signal = input.signal) {
        const result = await client.callTool(
          { name, arguments: arguments_ },
          undefined,
          { signal: combinedAbortSignal(signal, CALL_TIMEOUT_MS), timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
        );
        return {
          content: Array.isArray(result.content) ? result.content.slice(0, 100) : [],
          structuredContent: result.structuredContent ? plainRecord(result.structuredContent) : undefined,
          isError: Boolean(result.isError),
        } satisfies McpCallResult;
      },
      async close() {
        await transport.terminateSession().catch(() => undefined);
        await client.close().catch(() => transport.close());
      },
    };
  }
}
