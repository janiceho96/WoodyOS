import { createHash, randomBytes } from 'node:crypto';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { query } from '../db/client.js';
import type { EncryptedPayload } from '../lib/crypto.js';
import {
  decryptMcpCredentials,
  encryptMcpCredentials,
} from './credentials.js';
import { McpError } from './errors.js';
import { assertSafeMcpEndpoint, createSafeMcpFetch } from './network.js';

type OAuthConnection = {
  id: string;
  workspace_id: string;
  endpoint_url: string;
  encrypted_credentials: EncryptedPayload | null;
};

type StoredOAuthState = {
  oauthState?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
};

function callbackUrl() {
  return process.env.MCP_OAUTH_CALLBACK_URL
    ?? `${process.env.API_PUBLIC_URL ?? 'http://localhost:3001'}/v1/mcp/oauth/callback`;
}

function appUrl(status: 'success' | 'error', connectionId?: string) {
  const url = new URL('/mcp', process.env.MCP_APP_URL ?? 'http://localhost:3002');
  url.searchParams.set('oauth', status);
  if (connectionId) url.searchParams.set('connection', connectionId);
  return url;
}

export function oauthStateHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function safeOAuthFetch(input: string | URL | Request, init?: RequestInit) {
  const target = await assertSafeMcpEndpoint(input instanceof Request ? input.url : String(input));
  return createSafeMcpFetch(target)(target, init);
}

class StoredOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private stateData: StoredOAuthState;

  constructor(
    private readonly connection: OAuthConnection,
    private readonly persistChanges: boolean,
  ) {
    this.stateData = decryptMcpCredentials(
      connection.workspace_id,
      connection.id,
      connection.encrypted_credentials,
    ) as StoredOAuthState;
  }

  get redirectUrl() {
    return callbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Woody',
      redirect_uris: [callbackUrl()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state() {
    if (!this.stateData.oauthState) this.stateData.oauthState = randomBytes(32).toString('base64url');
    return this.stateData.oauthState;
  }

  clientInformation() {
    return this.stateData.clientInformation;
  }

  async saveClientInformation(value: OAuthClientInformationMixed) {
    this.stateData.clientInformation = value;
    await this.persist();
  }

  tokens() {
    return this.stateData.tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    this.stateData.tokens = tokens;
    await this.persist();
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(codeVerifier: string) {
    this.stateData.codeVerifier = codeVerifier;
    await this.persist();
  }

  codeVerifier() {
    if (!this.stateData.codeVerifier) throw new McpError('MCP_OAUTH_VERIFIER_MISSING', 'The OAuth authorization session expired', 400);
    return this.stateData.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState) {
    this.stateData.discoveryState = state;
    await this.persist();
  }

  discoveryState() {
    return this.stateData.discoveryState;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') delete this.stateData.clientInformation;
    if (scope === 'all' || scope === 'tokens') delete this.stateData.tokens;
    if (scope === 'all' || scope === 'verifier') delete this.stateData.codeVerifier;
    if (scope === 'all' || scope === 'discovery') delete this.stateData.discoveryState;
    await this.persist();
  }

  async persist() {
    if (!this.persistChanges) return;
    const encrypted = encryptMcpCredentials(
      this.connection.workspace_id,
      this.connection.id,
      this.stateData as Record<string, unknown>,
    );
    await query(
      'UPDATE mcp_connections SET encrypted_credentials=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3',
      [JSON.stringify(encrypted), this.connection.id, this.connection.workspace_id],
    );
  }

  async complete() {
    delete this.stateData.codeVerifier;
    delete this.stateData.oauthState;
    await this.persist();
  }
}

export function oauthProviderForRuntime(connection: OAuthConnection) {
  return new StoredOAuthProvider(connection, true);
}

export async function startMcpOAuth(workspaceId: string, connectionId: string) {
  const result = await query<OAuthConnection>(
    `SELECT id,workspace_id,endpoint_url,encrypted_credentials FROM mcp_connections
     WHERE id=$1 AND workspace_id=$2 AND auth_type='oauth2' AND deleted_at IS NULL`,
    [connectionId, workspaceId],
  );
  if (!result.rowCount) throw new McpError('MCP_OAUTH_CONNECTION_NOT_FOUND', 'OAuth MCP connection not found', 404);
  const connection = result.rows[0];
  const provider = new StoredOAuthProvider(connection, true);
  const outcome = await auth(provider, {
    serverUrl: connection.endpoint_url,
    fetchFn: safeOAuthFetch,
  });
  await provider.persist();
  if (outcome !== 'REDIRECT' || !provider.authorizationUrl) {
    throw new McpError('MCP_OAUTH_REDIRECT_MISSING', 'The MCP server did not provide an OAuth authorization page', 502);
  }
  const state = await provider.state();
  await provider.persist();
  await query(
    `UPDATE mcp_connections SET auth_metadata=$1,health_status='auth_required',updated_at=now()
     WHERE id=$2 AND workspace_id=$3`,
    [JSON.stringify({ oauthStateHash: oauthStateHash(state), startedAt: new Date().toISOString() }), connectionId, workspaceId],
  );
  return provider.authorizationUrl.toString();
}

export async function finishMcpOAuth(code: string, state: string) {
  const stateHash = oauthStateHash(state);
  const result = await query<OAuthConnection>(
    `SELECT id,workspace_id,endpoint_url,encrypted_credentials FROM mcp_connections
     WHERE auth_type='oauth2' AND deleted_at IS NULL AND auth_metadata->>'oauthStateHash'=$1`,
    [stateHash],
  );
  if (!result.rowCount) throw new McpError('MCP_OAUTH_STATE_INVALID', 'The OAuth authorization session is invalid or expired', 400);
  const connection = result.rows[0];
  const provider = new StoredOAuthProvider(connection, true);
  const storedState = await provider.state();
  if (storedState !== state) throw new McpError('MCP_OAUTH_STATE_INVALID', 'The OAuth authorization state did not match', 400);
  const outcome = await auth(provider, {
    serverUrl: connection.endpoint_url,
    authorizationCode: code,
    fetchFn: safeOAuthFetch,
  });
  if (outcome !== 'AUTHORIZED') throw new McpError('MCP_OAUTH_NOT_AUTHORIZED', 'The MCP OAuth server did not authorize this connection', 401);
  await provider.complete();
  await query(
    `UPDATE mcp_connections SET auth_metadata=$1,health_status='unknown',
     last_error_code=NULL,last_error_message=NULL,updated_at=now() WHERE id=$2`,
    [JSON.stringify({ authorizedAt: new Date().toISOString() }), connection.id],
  );
  return { connection, redirectUrl: appUrl('success', connection.id) };
}

export function oauthErrorRedirect() {
  return appUrl('error');
}
