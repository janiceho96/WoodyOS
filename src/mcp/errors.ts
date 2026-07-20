export class McpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 502,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'McpError';
  }
}

export function humanMcpError(error: unknown) {
  if (error instanceof McpError) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new McpError('MCP_REGISTRY_TIMEOUT', 'The MCP Registry did not respond in time', 504, { cause: error });
  }
  return new McpError('MCP_REGISTRY_UNAVAILABLE', 'The MCP Registry could not be reached', 502, { cause: error });
}
