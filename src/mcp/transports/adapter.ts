export type McpDiscoveredTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: Record<string, unknown>;
};

export type McpConnectionInfo = {
  serverInfo: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  instructions?: string;
  sessionId?: string;
};

export type McpCallResult = {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

export interface McpTransportSession {
  readonly info: McpConnectionInfo;
  ping(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<McpDiscoveredTool[]>;
  callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpTransportAdapter {
  readonly transport: string;
  connect(input: {
    endpointUrl: string;
    headers?: Record<string, string>;
    authProvider?: import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider;
    signal?: AbortSignal;
  }): Promise<McpTransportSession>;
}
