// enterprise_server/src/models/connectorOauthRedirect.ts

/**
 * The loopback redirect URI a desktop uses for a connector's `user-oauth`
 * flow — the single source of truth for it.
 *
 * Why the server owns it: the redirect URI is what the org admin registers
 * at the upstream IdP, and the desktop is what actually sends it. Both sides
 * have to agree, and the enterprise server is the only place the whole org
 * sees. So the server decides the URI, hands it to the desktop with the
 * connector (`oauth.redirectUri`), and shows it in the console for the admin
 * to copy into the IdP's app registration.
 *
 * Why a FIXED port: many IdPs (Okta, Azure AD) match the redirect URI
 * EXACTLY, so an ephemeral port can never be registered and the exchange
 * fails with `redirect_uri_mismatch`. RFC 8252 §7.3 lets an AS accept any
 * loopback port, but relying on that is how the flow breaks against a strict
 * IdP. An enterprise whose network blocks this port can move it with
 * `MCP_OAUTH_REDIRECT_PORT`.
 *
 * Why the loopback LITERAL: the desktop binds the IPv4 loopback and
 * advertises `127.0.0.1`; a browser that resolves `localhost` to `::1`
 * would deliver the authorization code to a socket nobody is listening on.
 */
export const MCP_OAUTH_REDIRECT_PORT_DEFAULT = 53232;

export interface ResolvedMcpOAuthRedirectPort {
  /** The port number (1..65535). */
  port: number;
  /** True when process.env.MCP_OAUTH_REDIRECT_PORT was the source. */
  fromEnv: boolean;
}

/**
 * The effective port: `MCP_OAUTH_REDIRECT_PORT` when it is a valid port,
 * otherwise the default. An invalid value is treated as unset so the server
 * never hands out a URI the desktop cannot bind.
 */
export function resolveMcpOAuthRedirectPort(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMcpOAuthRedirectPort {
  const raw = env.MCP_OAUTH_REDIRECT_PORT;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) {
      return { port: n, fromEnv: true };
    }
  }
  return { port: MCP_OAUTH_REDIRECT_PORT_DEFAULT, fromEnv: false };
}

/** The redirect URI the desktop sends and the admin registers. */
export function mcpOAuthRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${resolveMcpOAuthRedirectPort(env).port}/callback`;
}
