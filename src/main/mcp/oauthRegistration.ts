/**
 * RFC 7591 dynamic client registration for the connector OAuth flow.
 *
 * Why it exists: a growing set of MCP authorization servers (and every MCP
 * server relying on the spec's own OAuth profile) expect the client to
 * register itself at first use instead of an admin pre-creating an app and
 * pasting a client id into the console. The desktop is a public PKCE client
 * (RFC 8252 native app), so it registers with
 * `token_endpoint_auth_method: 'none'` and its loopback redirect — no secret
 * is requested and none is stored.
 *
 * The registered client id is stateful (the AS bound the redirect URI to it),
 * so the caller persists it on the connector record and never re-registers
 * unless the config is replaced.
 */

import { type FetchLike,isTrustedUrl } from './oauthDiscovery';

export interface RegisterPublicClientArgs {
  /** The AS's `registration_endpoint`, from its metadata document. */
  registrationEndpoint: string;
  /** The exact loopback URI the desktop binds — also the one it will send. */
  redirectUri: string;
  clientName?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface RegisteredPublicClient {
  clientId: string;
  /** Always 'none': the flow has no secret to send, by design. */
  tokenEndpointAuthMethod: 'none';
  /** RFC 7591 §3.2.1 — kept only to document that the AS may issue one. */
  registrationAccessToken?: string;
}

export class OAuthRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthRegistrationError';
  }
}

/** The registration request body. Exported so a test can pin the exact wire
 *  shape — every field here is something an AS has rejected in the wild. */
export function buildRegistrationBody(redirectUri: string, clientName: string): Record<string, unknown> {
  return {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export async function registerPublicClient(args: RegisterPublicClientArgs): Promise<RegisteredPublicClient> {
  const {
    registrationEndpoint,
    redirectUri,
    clientName = 'MixCWork Desktop',
    fetchImpl = fetch,
    timeoutMs = 8000,
  } = args;

  if (!isTrustedUrl(registrationEndpoint)) {
    throw new OAuthRegistrationError(
      `dynamic client registration needs an https endpoint (plain http only on loopback): ${registrationEndpoint}`,
    );
  }

  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(buildRegistrationBody(redirectUri, clientName)),
    signal,
  });

  let body: Record<string, unknown> | null = null;
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }

  if (!res.ok) {
    const code = typeof body?.error === 'string' ? body.error : '';
    const description = typeof body?.error_description === 'string' ? body.error_description : '';
    const detail = [code, description].filter(Boolean).join(' — ');
    throw new OAuthRegistrationError(
      `dynamic client registration failed: HTTP ${res.status}${detail ? ` (${detail})` : ''}`,
    );
  }

  const clientId = typeof body?.client_id === 'string' ? body.client_id : '';
  if (!clientId) {
    throw new OAuthRegistrationError(
      'dynamic client registration returned no client_id — the provider did not issue a client, so the flow cannot continue',
    );
  }

  // A confidential client is not something this flow can drive: the token
  // exchange sends no secret. Say so instead of failing later at the token
  // endpoint with an opaque error.
  const authMethod = typeof body?.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
  if (authMethod !== 'none') {
    throw new OAuthRegistrationError(
      `the provider registered a confidential client (token_endpoint_auth_method=${authMethod}); ` +
        'MixCWork drives a public PKCE client with no secret — ask your admin to configure a client id for this connector instead',
    );
  }

  const registrationAccessToken =
    typeof body?.registration_access_token === 'string' ? body.registration_access_token : undefined;

  return {
    clientId,
    tokenEndpointAuthMethod: 'none',
    ...(registrationAccessToken ? { registrationAccessToken } : {}),
  };
}
