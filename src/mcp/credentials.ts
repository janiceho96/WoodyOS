import { decryptJsonWithContext, encryptJsonWithContext, type EncryptedPayload } from '../lib/crypto.js';
import { McpError } from './errors.js';
import { safeMcpHeaders } from './network.js';

export type McpAuthInput =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'custom_headers'; headers: Record<string, string> }
  | { type: 'oauth2'; clientId?: string; clientSecret?: string };

function context(workspaceId: string, connectionId: string) {
  return `mcp:${workspaceId}:${connectionId}`;
}

export function credentialPayload(auth: McpAuthInput) {
  if (auth.type === 'none') return null;
  if (auth.type === 'bearer') {
    if (!auth.token.trim() || auth.token.length > 16_000 || /[\r\n]/.test(auth.token)) {
      throw new McpError('MCP_CREDENTIAL_INVALID', 'Enter a valid bearer token', 400);
    }
    return { token: auth.token };
  }
  if (auth.type === 'custom_headers') return { headers: safeMcpHeaders(auth.headers) };
  if (!auth.clientId) return null;
  if (
    auth.clientId.length > 2_000
    || /[\r\n]/.test(auth.clientId)
    || (auth.clientSecret && (auth.clientSecret.length > 8_000 || /[\r\n]/.test(auth.clientSecret)))
  ) {
    throw new McpError('MCP_OAUTH_CLIENT_INVALID', 'Enter a valid OAuth client ID and secret', 400);
  }
  return {
    clientInformation: {
      client_id: auth.clientId,
      ...(auth.clientSecret ? { client_secret: auth.clientSecret } : {}),
    },
  };
}

export function encryptMcpCredentials(
  workspaceId: string,
  connectionId: string,
  credentials: Record<string, unknown>,
) {
  return encryptJsonWithContext(credentials, context(workspaceId, connectionId));
}

export function decryptMcpCredentials(
  workspaceId: string,
  connectionId: string,
  payload: EncryptedPayload | null,
) {
  if (!payload) return {};
  return decryptJsonWithContext(payload, context(workspaceId, connectionId));
}

export function requestHeaders(authType: string, credentials: Record<string, unknown>) {
  if (authType === 'none') return {};
  if (authType === 'bearer') {
    if (typeof credentials.token !== 'string') throw new McpError('MCP_AUTH_REQUIRED', 'This connection needs a bearer token', 401);
    return { authorization: `Bearer ${credentials.token}` };
  }
  if (authType === 'custom_headers') {
    if (!credentials.headers || typeof credentials.headers !== 'object' || Array.isArray(credentials.headers)) {
      throw new McpError('MCP_AUTH_REQUIRED', 'This connection needs authentication headers', 401);
    }
    return safeMcpHeaders(credentials.headers as Record<string, unknown>);
  }
  throw new McpError('MCP_OAUTH_REQUIRED', 'Complete OAuth authorization before testing this connection', 401);
}
