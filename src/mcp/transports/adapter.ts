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
  ping(): Promise<void>;
  listTools(): Promise<McpDiscoveredTool[]>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpTransportAdapter {
  readonly transport: string;
  connect(input: {
    endpointUrl: string;
    headers?: Record<string, string>;
    authProvider?: import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider;
  }): Promise<McpTransportSession>;
}
