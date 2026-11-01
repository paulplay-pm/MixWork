import type { AddressInfo } from 'node:net';

import crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import http from 'http';

import { OAuthNetworkPolicy,openOauthFlow } from './oauthBrowserFlow';
import { type DiscoveredOAuth,discoverOAuthEndpoints } from './oauthDiscovery';
import { registerPublicClient } from './oauthRegistration';

export interface GenericOauthConfig {
  /** Absent when the org left the endpoints to discovery (RFC 8414 / 9728). */
  authorizeUrl?: string;
  tokenUrl?: string;
  /** Absent when the org left the client to dynamic registration (RFC 7591). */
  clientId?: string;
  scopes?: string[];
  /** The loopback redirect URI the enterprise server wants registered at the
   *  upstream IdP. The desktop binds this port and sends this URI as
   *  `redirect_uri`; absent means "use the built-in default". */
  redirectUri?: string;
  /** The MCP server URL. Discovery walks from here when the org did not pin
   *  every piece of the client profile. */
  resourceUrl?: string;
}

/** The loopback port the connector OAuth flow binds when the enterprise
 *  server did not send a redirect URI.
 *
 *  Why a FIXED port and not an ephemeral one: the admin registers the
 *  redirect URI at the upstream IdP, and many IdPs (Okta, Azure AD in its
 *  "single tenant application" mode) match the redirect URI EXACTLY — an
 *  ephemeral port can never be registered, so the exchange would fail with
 *  `redirect_uri_mismatch`. RFC 8252 §7.3 lets an AS accept any loopback
 *  port, but relying on that is how the flow breaks against a strict IdP.
 *
 *  The enterprise server sends the authoritative URI with the connector
 *  (`oauth.redirectUri`); this constant is the fallback for a connector the
 *  server did not describe, and must match the server's default. */
export const MCP_OAUTH_REDIRECT_PORT_DEFAULT = 53232;

export interface ResolvedRedirect {
  /** The exact `redirect_uri` the desktop sends to the IdP. */
  uri: string;
  /** The loopback port the callback server binds. */
  port: number;
}

/** The loopback port carried by a configured redirect URI, or null when the
 *  URI is not one this process can bind. Only `http` on a loopback host with
 *  an explicit port qualifies: a server-hosted callback (an `https` URL on
 *  the enterprise server) is not something the desktop can listen on, and an
 *  ephemeral port would not be registrable upstream either. */
function loopbackPort(uri: string | undefined): number | null {
  if (!uri) return null;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return port;
}

/** Decide which loopback redirect URI this flow uses.
 *
 *  The host is always the loopback LITERAL (`127.0.0.1`), never `localhost`:
 *  the callback server binds the IPv4 loopback, and a browser that resolves
 *  `localhost` to `::1` would send the code to a socket nobody is listening
 *  on. Only the port is taken from the configured URI. */
export function resolveRedirect(configured?: string): ResolvedRedirect {
  const port = loopbackPort(configured) ?? MCP_OAUTH_REDIRECT_PORT_DEFAULT;
  return { uri: `http://127.0.0.1:${port}/callback`, port };
}

export function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(64));
  return {
    verifier,
    // RFC 7636 §4.2: the IdP computes BASE64URL(SHA256(code_verifier)) over the
    // verifier STRING it receives — so hash the base64url string, not the raw bytes.
    challenge: base64UrlEncode(crypto.createHash('sha256').update(verifier).digest()),
    state: base64UrlEncode(crypto.randomBytes(32)),
  };
}

export function buildGenericAuthorizeUrl(args: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  state: string;
  challenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: 'S256',
  });
  if (args.scopes && args.scopes.length > 0) params.set('scope', args.scopes.join(' '));
  const base = args.authorizeUrl.includes('?')
    ? `${args.authorizeUrl}&${params.toString()}`
    : `${args.authorizeUrl}?${params.toString()}`;
  return base;
}

export function buildTokenExchangeBody(args: {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri?: string;
}): string {
  // Public client (PKCE): token_endpoint_auth_method=none — no client secret.
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
  });
  // RFC 6749 §4.1.3: `redirect_uri` is REQUIRED when it was included in the
  // authorization request, and it MUST be the same value. IdPs that match
  // the redirect URI exactly reject the exchange when it is missing.
  if (args.redirectUri) params.set('redirect_uri', args.redirectUri);
  return params.toString();
}

export function parseTokenResponse(text: string): string {
  let data: { access_token?: string; error?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('oauth token exchange: non-JSON response');
  }
  if (data.error) throw new Error(`oauth token exchange failed: ${data.error}`);
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('oauth token exchange: missing access_token');
  }
  return data.access_token;
}

/** Everything the flow needs after the org's config and discovery are merged. */
export interface ResolvedOauthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  redirectUri: string;
  /** True when discovery supplied an endpoint the org did not configure. */
  discoveredEndpoints: boolean;
  /** True when this run registered a client (it must be persisted). */
  registeredClient: boolean;
}

/** Injected for tests; production uses the real network calls. */
export interface ResolveOauthDeps {
  discover?: (args: { resourceUrl: string }) => Promise<DiscoveredOAuth>;
  register?: (args: {
    registrationEndpoint: string;
    redirectUri: string;
  }) => Promise<{ clientId: string }>;
}

/**
 * Merge the org's client profile with what discovery can learn, in that
 * order. The admin's values always win field by field: a pinned token URL is
 * never replaced, and a pinned client id is never re-registered (the AS bound
 * its redirect URI to it).
 */
export async function resolveOauthEndpoints(
  cfg: GenericOauthConfig,
  redirect: ResolvedRedirect,
  deps: ResolveOauthDeps = {},
): Promise<ResolvedOauthEndpoints> {
  const authorizeUrl = (cfg.authorizeUrl ?? '').trim();
  const tokenUrl = (cfg.tokenUrl ?? '').trim();
  let clientId = (cfg.clientId ?? '').trim();
  const wantedUndiscovered = [!authorizeUrl && 'authorize URL', !tokenUrl && 'token URL', !clientId && 'client id']
    .filter(Boolean) as string[];
  let discoveredEndpoints = false;
  let registeredClient = false;

  if (wantedUndiscovered.length > 0) {
    const resourceUrl = (cfg.resourceUrl ?? '').trim();
    if (!resourceUrl) {
      throw new Error(
        `oauth config is incomplete (missing ${wantedUndiscovered.join(', ')}) and discovery ` +
          'needs the connector URL; set these fields in the enterprise console or reinstall the connector',
      );
    }
    const discover = deps.discover ?? discoverOAuthEndpoints;
    const metadata = await discover({ resourceUrl });
    if (!authorizeUrl) discoveredEndpoints = true;
    if (!tokenUrl) discoveredEndpoints = true;
    if (!clientId) {
      if (!metadata.registrationEndpoint) {
        throw new Error(
          'this connector has no client id in the enterprise console and its provider does not offer ' +
            'dynamic client registration; ask your admin to set a client id for this connector',
        );
      }
      const register = deps.register ?? registerPublicClient;
      const registered = await register({
        registrationEndpoint: metadata.registrationEndpoint,
        redirectUri: redirect.uri,
      });
      clientId = registered.clientId;
      registeredClient = true;
    }
    return {
      authorizeUrl: authorizeUrl || metadata.authorizeUrl,
      tokenUrl: tokenUrl || metadata.tokenUrl,
      clientId,
      ...(cfg.scopes && cfg.scopes.length > 0 ? { scopes: cfg.scopes } : {}),
      redirectUri: redirect.uri,
      discoveredEndpoints,
      registeredClient,
    };
  }

  return {
    authorizeUrl,
    tokenUrl,
    clientId,
    ...(cfg.scopes && cfg.scopes.length > 0 ? { scopes: cfg.scopes } : {}),
    redirectUri: redirect.uri,
    discoveredEndpoints: false,
    registeredClient: false,
  };
}

/** One-shot localhost callback server that captures the authorization `code`
 * (validating `state`) exactly once. Returns `{ redirectUri, wait, close }` —
 * `wait` resolves to the captured code (or null if the window closes first). */
function startCodeCallback(expectedState: string, port: number): Promise<{
  redirectUri: string;
  wait: () => Promise<string | null>;
  close: () => void;
}> {
  let resolveCode: ((c: string | null) => void) | null = null;
  const codePromise = new Promise<string | null>((r) => {
    resolveCode = r;
  });
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url || '/', 'http://localhost');
      if (parsed.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const state = parsed.searchParams.get('state');
      const code = parsed.searchParams.get('code');
      if (state !== expectedState || !code) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Invalid callback');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Authorization complete</h1><p>You can return to MixcWork.</p>');
      resolveCode?.(code); // resolve-once; later polls get the same settlement
    });
    server.once('error', (err: NodeJS.ErrnoException) => {
      // A busy port is the one failure the fixed-port design introduces, and
      // the raw errno tells the user nothing about what to do.
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `OAuth callback port ${port} is already in use — another MixCWork window ` +
          'is probably authorizing right now; close it and try again.',
        ));
        return;
      }
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to allocate OAuth callback port'));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${(addr as AddressInfo).port}/callback`,
        wait: () => codePromise,
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore close races */
          }
        },
      });
    });
  });
}

/** Everything the token exchange needs, injected so the single-flight rule can
 *  be tested without an Electron window or a live IdP. */
export interface TokenExchangeProbeDeps {
  waitForCode: () => Promise<string | null>;
  exchange: (code: string) => Promise<string>;
  closeWindow: (win: BrowserWindow | null) => void;
  onError: (err: Error) => void;
}

/**
 * Build the probe `openOauthFlow` polls.
 *
 * `openOauthFlow` invokes the probe on every `did-finish-load` and again on its
 * poll interval, and `waitForCode` keeps handing back the code it has already
 * captured. So the exchange MUST be single-flight: an authorization code is
 * single-use (RFC 6749 §4.1.2). 纷享销客 answers the duplicate with
 * "token已下发，请勿重复下发！" — and because the duplicates run concurrently
 * with the exchange that actually succeeded, the failures close the window and
 * settle the flow with an error before the winner's token can be returned. The
 * user sees "probe failed" while the IdP has already burned the code.
 */
export function createTokenExchangeProbe(
  deps: TokenExchangeProbeDeps
): (win: BrowserWindow | null) => Promise<string | null> {
  let exchange: Promise<string> | null = null;
  let windowClosed = false;
  return async (win) => {
    const code = await deps.waitForCode();
    if (!code) return null;
    if (!exchange) exchange = deps.exchange(code);
    try {
      return await exchange;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      deps.onError(err);
      if (!windowClosed) {
        windowClosed = true;
        deps.closeWindow(win);
      }
      throw err;
    }
  };
}

/** Drive the full generic authorization-code + PKCE flow for one connector's
 * own endpoints and return the access token. The pure pieces above are unit
 * tested; this orchestration uses Electron + `openOauthFlow`. */
export interface GenericOauthFlowOptions extends ResolveOauthDeps {
  /** Called once the client profile is final, before the browser opens — the
   *  caller persists a freshly registered client id here. */
  onResolved?: (resolved: ResolvedOauthEndpoints) => void;
}

export async function runGenericOauthFlow(
  oauthConfig: GenericOauthConfig,
  parentWindow: BrowserWindow | null,
  options: GenericOauthFlowOptions = {},
): Promise<string> {
  const redirect = resolveRedirect(oauthConfig.redirectUri);
  // Discover/register BEFORE binding the callback port: a failure here must
  // not leave a port held, and the browser must never open for a flow that
  // cannot finish.
  const resolved = await resolveOauthEndpoints(oauthConfig, redirect, options);
  options.onResolved?.(resolved);
  const { verifier, challenge, state } = createPkce();
  const cb = await startCodeCallback(state, redirect.port);
  let exchangeError: Error | null = null;
  try {
    const authorizeUrl = buildGenericAuthorizeUrl({
      authorizeUrl: resolved.authorizeUrl,
      clientId: resolved.clientId,
      redirectUri: cb.redirectUri,
      scopes: resolved.scopes,
      state,
      challenge,
    });
    const probe = createTokenExchangeProbe({
      waitForCode: () => cb.wait(),
      exchange: async (code) => {
        const res = await fetch(resolved.tokenUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: buildTokenExchangeBody({
            code,
            codeVerifier: verifier,
            clientId: resolved.clientId,
            redirectUri: cb.redirectUri,
          }),
        });
        const text = await res.text();
        if (!res.ok) {
          // Surface the IdP's own reason next to the status: a bare
          // "HTTP 400" is indistinguishable from a misconfigured endpoint,
          // while "(invalid_grant …)" names the actual problem.
          let detail = '';
          try {
            const body = JSON.parse(text) as { error?: string; error_description?: string };
            detail = body.error_description ?? body.error ?? '';
          } catch {
            /* non-JSON body — the status alone has to do */
          }
          throw new Error(
            `oauth token exchange failed: HTTP ${res.status}${detail ? ` (${detail})` : ''}`,
          );
        }
        return parseTokenResponse(text);
      },
      closeWindow: (win) => {
        try {
          win?.close();
        } catch {
          /* window may already be gone */
        }
      },
      onError: (err) => {
        exchangeError = err;
      },
    });
    try {
      const token = await openOauthFlow({
        parentWindow,
        title: 'MCP OAuth Authorization',
        authorizeUrl,
        // The authorization server came from discovery, not from a vendored
        // SSO table, and IdP login pages pull their assets from CDNs on other
        // eTLD+1s (a9.fspage.com, g.alicdn.com). The strict identity filter
        // cancels those and the login page renders blank, so this window
        // gets the open policy: https anywhere, loopback always, plaintext
        // http outside the allowlist never.
        networkPolicy: OAuthNetworkPolicy.Open,
        probe,
      });
      if (!token) throw new Error('oauth flow returned empty credential');
      return token;
    } catch (e) {
      // openOauthFlow swallows probe throws and settles via the window-close
      // handler with a generic message — re-surface the specific exchange error
      // (HTTP status / IdP error) when it is the actual cause.
      if (exchangeError) throw exchangeError;
      throw e;
    }
  } finally {
    cb.close();
  }
}
