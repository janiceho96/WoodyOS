import { lookup as lookupAll } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import { isPublicIp } from './network.js';

function providerEndpointError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function normalizeCompatibleBaseUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw providerEndpointError('AI_PROVIDER_ENDPOINT_INVALID', 'Enter a valid AI provider base URL.', 400); }
  if (url.protocol !== 'https:') throw providerEndpointError('AI_PROVIDER_ENDPOINT_HTTPS_REQUIRED', 'AI provider endpoints must use HTTPS.', 400);
  if (url.username || url.password) throw providerEndpointError('AI_PROVIDER_ENDPOINT_CREDENTIALS_FORBIDDEN', 'Do not place credentials inside the provider URL.', 400);
  if (url.hash || url.search) throw providerEndpointError('AI_PROVIDER_ENDPOINT_INVALID', 'AI provider base URLs cannot contain query strings or fragments.', 400);
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export function createSafeProviderFetch(baseUrl: string): typeof fetch {
  const endpoint = new URL(baseUrl);
  const lookup: LookupFunction = (hostname, options, callback) => {
    void lookupAll(hostname, { all: true, verbatim: true }).then((addresses) => {
      if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
        callback(providerEndpointError('AI_PROVIDER_ENDPOINT_BLOCKED', 'The provider resolved to a private or reserved network address.', 502), '', 0);
        return;
      }
      deliverLookup(options, preferredAddress(addresses), callback);
    }).catch((error: NodeJS.ErrnoException) => callback(error, '', 0));
  };
  const dispatcher = new Agent({ connect: buildConnector({ lookup }), connections: 4, pipelining: 0, keepAliveTimeout: 5_000 });
  const expectedOrigin = endpoint.origin;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== expectedOrigin) throw providerEndpointError('AI_PROVIDER_REDIRECT_BLOCKED', 'The provider request attempted to leave its configured origin.', 502);
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

function preferredAddress(addresses: LookupAddress[]) {
  const ipv4 = addresses.filter((entry) => entry.family === 4);
  const candidates = ipv4.length ? ipv4 : addresses;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function deliverLookup(options: LookupOptions, selected: LookupAddress, callback: LookupCallback) {
  if (options.all) callback(null, [selected]);
  else callback(null, selected.address, selected.family);
}
