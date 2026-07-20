import { lookup as lookupAll } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import { isPublicIp } from '../lib/network.js';
import { McpError } from './errors.js';

const BLOCKED_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'origin',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export async function assertSafeMcpEndpoint(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpError('MCP_ENDPOINT_INVALID', 'Enter a valid MCP endpoint URL', 400);
  }
  if (url.protocol !== 'https:') throw new McpError('MCP_ENDPOINT_HTTPS_REQUIRED', 'MCP endpoints must use HTTPS', 400);
  if (url.username || url.password) throw new McpError('MCP_ENDPOINT_CREDENTIALS_FORBIDDEN', 'Credentials cannot be embedded in an MCP endpoint URL', 400);
  if (url.hash) throw new McpError('MCP_ENDPOINT_FRAGMENT_FORBIDDEN', 'MCP endpoint URLs cannot contain fragments', 400);
  const addresses = await lookupAll(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length) throw new McpError('MCP_ENDPOINT_DNS_FAILED', 'The MCP endpoint hostname could not be resolved', 400);
  if (addresses.some(({ address }) => !isPublicIp(address))) {
    throw new McpError('MCP_ENDPOINT_BLOCKED', 'Private, local, and reserved network endpoints are not allowed', 400);
  }
  return url;
}

export function safeMcpHeaders(value: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || BLOCKED_HEADERS.has(normalized)) {
      throw new McpError('MCP_HEADER_FORBIDDEN', `The ${name || 'empty'} header cannot be configured`, 400);
    }
    if (typeof entry !== 'string' || entry.length > 8_000 || /[\r\n]/.test(entry)) {
      throw new McpError('MCP_HEADER_INVALID', `The ${name} header has an invalid value`, 400);
    }
    headers[name] = entry;
  }
  return headers;
}

export function createSafeMcpFetch(endpoint: URL): typeof fetch {
  const lookup: LookupFunction = (hostname, options, callback) => {
    void lookupAll(hostname, { all: true, verbatim: true }).then((addresses) => {
      if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
        callback(Object.assign(new Error('MCP endpoint resolved to a blocked network address'), { code: 'EACCES' }), '', 0);
        return;
      }
      const selected = selectPreferredAddress(addresses);
      deliverLookupResult(options, selected, callback);
    }).catch((error: NodeJS.ErrnoException) => callback(error, '', 0));
  };
  const dispatcher = new Agent({
    connect: buildConnector({ lookup }),
    connections: 4,
    pipelining: 0,
    keepAliveTimeout: 5_000,
  });
  const expectedOrigin = endpoint.origin;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== expectedOrigin) {
      throw new McpError('MCP_REDIRECT_BLOCKED', 'MCP requests cannot leave the configured server origin', 502);
    }
    const response = await undiciFetch(target, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
      redirect: 'error',
      headers: init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined,
    });
    return response as unknown as Response;
  }) as typeof fetch;
}

type LookupCallback = Parameters<LookupFunction>[2];

export function selectPreferredAddress(addresses: LookupAddress[]) {
  // Docker Desktop commonly publishes public AAAA records to containers even
  // when its VM has no usable IPv6 route. Prefer a validated IPv4 address when
  // one exists, while retaining IPv6 support for IPv6-only destinations.
  const ipv4 = addresses.filter((entry) => entry.family === 4);
  const candidates = ipv4.length ? ipv4 : addresses;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function deliverLookupResult(
  options: LookupOptions,
  selected: LookupAddress,
  callback: LookupCallback,
) {
  // Node enables autoSelectFamily for outbound sockets on modern releases and
  // then calls custom lookup functions with `all: true`. In that mode the
  // callback must receive LookupAddress[], otherwise Node treats string
  // properties as address records and attempts to connect to `undefined`.
  // Returning a one-item array keeps the validated DNS result pinned.
  if (options.all) {
    callback(null, [selected]);
    return;
  }
  callback(null, selected.address, selected.family);
}
