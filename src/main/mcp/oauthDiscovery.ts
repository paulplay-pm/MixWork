/**
 * OAuth metadata discovery for MCP connectors (RFC 9728 + RFC 8414 / OIDC).
 *
 * Why this exists: an enterprise connector's admin used to have to type in
 * the upstream IdP's authorize URL, token URL and a client id. Most MCP
 * servers now publish their authorization server instead — the connector is
 * just a URL, and the client is expected to discover the rest and register
 * itself. Without this module a connector like that cannot authorize at all
 * from the desktop.
 *
 * Order of travel (each step only when the previous one has no answer):
 *   1. `<resource>/.well-known/oauth-protected-resource` — RFC 9728. It names
 *      the authorization server(s) that protect this resource.
 *   2. A 401 `WWW-Authenticate: Bearer resource_metadata="…"` challenge from
 *      the resource itself, for servers that publish the document elsewhere.
 *   3. The authorization server's `/.well-known/oauth-authorization-server`
 *      (RFC 8414 §3.1: the well-known segment goes BEFORE an issuer path),
 *      then the OIDC discovery documents.
 *
 * The admin's own values always win over anything discovered here — see
 * `resolveOauthEndpoints` in genericOauthFlow.ts, which only calls this for
 * the parts the org did not pin.
 */

/** The one fetch shape this module (and oauthRegistration) accepts, so tests
 *  can inject a stub without touching the global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscoveredOAuth {
  authorizeUrl: string;
  tokenUrl: string;
  /** RFC 7591 dynamic client registration, when the AS advertises it. */
  registrationEndpoint?: string;
  issuer?: string;
  /** The metadata document that supplied the endpoints (diagnostics). */
  sourceUrl: string;
  /** The RFC 9728 document that named the issuer, when one did. */
  resourceMetadataUrl?: string;
}

export class OAuthDiscoveryError extends Error {
  /** Every URL the discovery walk asked, in order — the admin's debugging aid. */
  readonly tried: string[];
  constructor(message: string, tried: string[]) {
    super(message);
    this.name = 'OAuthDiscoveryError';
    this.tried = tried;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True for an absolute https URL, or an http URL on the loopback. Nothing
 *  else is ever fetched: a credential-bearing flow must not travel in clear
 *  text, and the loopback exception is what makes a local MCP server testable. */
export function isTrustedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

function assertTrustedUrl(url: string, label: string): void {
  if (!isTrustedUrl(url)) {
    throw new Error(`${label} must be an https URL (plain http only on loopback): ${url}`);
  }
}

/** RFC 9728 §3.1: the well-known segment is inserted before the resource's
 *  path, then the origin-level document is the documented fallback shape. */
export function protectedResourceMetadataUrls(resourceUrl: string): string[] {
  const u = new URL(resourceUrl);
  const path = u.pathname.replace(/\/+$/, '');
  const urls: string[] = [];
  if (path) urls.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  const originOnly = `${u.origin}/.well-known/oauth-protected-resource`;
  if (!urls.includes(originOnly)) urls.push(originOnly);
  return urls;
}

/** RFC 8414 §3.1 path insertion, then the OIDC variants (an OIDC discovery
 *  document lives at `<issuer>/.well-known/openid-configuration`). */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, '');
  if (!path) {
    return [
      `${u.origin}/.well-known/oauth-authorization-server`,
      `${u.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Pull `resource_metadata="…"` out of a `WWW-Authenticate: Bearer …` value. */
export function parseWwwAuthenticate(header: string): string | null {
  if (!header) return null;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  return match ? match[1] : null;
}

interface FetchOutcome {
  ok: boolean;
  status: number;
  json?: Record<string, unknown>;
  wwwAuthenticate?: string | null;
}

async function fetchJson(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<FetchOutcome> {
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetchImpl(url, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
    signal,
  });
  const outcome: FetchOutcome = {
    ok: res.ok,
    status: res.status,
    wwwAuthenticate: res.headers.get('www-authenticate'),
  };
  if (!res.ok) return outcome;
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      outcome.json = parsed as Record<string, unknown>;
    }
  } catch {
    /* a non-JSON body is simply not a metadata document */
  }
  return outcome;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Read an RFC 9728 document into the authorization server issuers it names. */
function readProtectedResource(doc: Record<string, unknown> | undefined): string[] {
  if (!doc) return [];
  return stringArray(doc.authorization_servers).filter((issuer) => isTrustedUrl(issuer));
}

interface AsRead {
  metadata?: Omit<DiscoveredOAuth, 'resourceMetadataUrl'>;
  note?: string;
}

/** Read an RFC 8414 / OIDC metadata document. Returns a note instead of
 *  metadata when the document exists but this flow cannot use it. */
function readAuthorizationServer(doc: Record<string, unknown> | undefined, sourceUrl: string): AsRead {
  if (!doc) return {};
  const authorizeUrl = typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : '';
  const tokenUrl = typeof doc.token_endpoint === 'string' ? doc.token_endpoint : '';
  if (!authorizeUrl || !tokenUrl) {
    return { note: `${sourceUrl}: metadata has no authorization_endpoint/token_endpoint` };
  }
  if (!isTrustedUrl(authorizeUrl) || !isTrustedUrl(tokenUrl)) {
    return { note: `${sourceUrl}: endpoints are not https (or loopback)` };
  }
  // MCP requires PKCE with S256. An AS that advertises only `plain` cannot
  // complete this flow, so say so instead of opening a window that will fail.
  const methods = stringArray(doc.code_challenge_methods_supported);
  if (methods.length > 0 && !methods.some((m) => m.toUpperCase() === 'S256')) {
    return { note: `${sourceUrl}: the provider does not advertise the S256 PKCE method this flow requires` };
  }
  const registrationEndpoint =
    typeof doc.registration_endpoint === 'string' && isTrustedUrl(doc.registration_endpoint)
      ? doc.registration_endpoint
      : undefined;
  return {
    metadata: {
      authorizeUrl,
      tokenUrl,
      registrationEndpoint,
      issuer: typeof doc.issuer === 'string' ? doc.issuer : undefined,
      sourceUrl,
    },
  };
}

export interface DiscoverOAuthArgs {
  /** The MCP server URL the connector points at (its discovery anchor). */
  resourceUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Walk the discovery chain for one MCP server URL and return the endpoints to
 * drive a PKCE flow against. Throws `OAuthDiscoveryError` — carrying every URL
 * it asked — when no authorization server answers.
 */
export async function discoverOAuthEndpoints(args: DiscoverOAuthArgs): Promise<DiscoveredOAuth> {
  const { resourceUrl, fetchImpl = fetch, timeoutMs = 8000 } = args;
  assertTrustedUrl(resourceUrl, 'the MCP server URL');

  const tried: string[] = [];
  const notes: string[] = [];

  const tryBase = async (
    issuer: string,
    resourceMetadataUrl: string | undefined,
  ): Promise<DiscoveredOAuth | null> => {
    for (const url of authorizationServerMetadataUrls(issuer)) {
      tried.push(url);
      let outcome: FetchOutcome;
      try {
        outcome = await fetchJson(url, fetchImpl, timeoutMs);
      } catch (err) {
        notes.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!outcome.ok) continue;
      const read = readAuthorizationServer(outcome.json, url);
      if (read.note) notes.push(read.note);
      if (read.metadata) {
        return {
          ...read.metadata,
          ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
        };
      }
    }
    return null;
  };

  // 1. The resource's own metadata document (path-suffixed form first).
  const resourceOrigin = new URL(resourceUrl).origin;
  for (const url of protectedResourceMetadataUrls(resourceUrl)) {
    tried.push(url);
    let outcome: FetchOutcome;
    try {
      outcome = await fetchJson(url, fetchImpl, timeoutMs);
    } catch (err) {
      notes.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!outcome.ok) continue;
    for (const issuer of readProtectedResource(outcome.json)) {
      const found = await tryBase(issuer, url);
      if (found) return found;
    }
  }

  // 2. A 401 challenge from the resource can point at the document directly.
  let challenged: FetchOutcome | null = null;
  try {
    tried.push(resourceUrl);
    challenged = await fetchJson(resourceUrl, fetchImpl, timeoutMs, { method: 'GET' });
  } catch (err) {
    notes.push(`${resourceUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const challengedUrl = challenged ? parseWwwAuthenticate(challenged.wwwAuthenticate ?? '') : null;
  if (challengedUrl && isTrustedUrl(challengedUrl)) {
    tried.push(challengedUrl);
    try {
      const outcome = await fetchJson(challengedUrl, fetchImpl, timeoutMs);
      for (const issuer of readProtectedResource(outcome.json)) {
        const found = await tryBase(issuer, challengedUrl);
        if (found) return found;
      }
    } catch (err) {
      notes.push(`${challengedUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. The resource's own origin as the authorization server, last.
  const found = await tryBase(resourceOrigin, undefined);
  if (found) return found;

  const details = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  throw new OAuthDiscoveryError(
    `oauth discovery failed for ${resourceUrl}: no authorization server metadata found${details}`,
    tried,
  );
}
