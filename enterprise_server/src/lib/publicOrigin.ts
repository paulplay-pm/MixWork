import type { Context } from 'hono';

/**
 * The origin the CLIENT should dial back on.
 *
 * The server usually sits behind TLS termination, so it cannot trust its own
 * `http://` view of the world: `req.headers.host` is right but the scheme is
 * not, and a `ws://` URL in a page served over HTTPS is blocked by the
 * browser. Both nginx and Caddy set `X-Forwarded-Proto` / `X-Forwarded-Host`,
 * so those are preferred; `PUBLIC_BASE_URL` overrides everything for
 * deployments that terminate elsewhere.
 *
 * Without this, a session response would hand the client a `ws://` URL and
 * the upgrade would fail in the browser rather than at the app — a failure
 * that looks like a network bug and is not one.
 */
export function resolvePublicWsOrigin(c: Context): string {
  const override = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (override) {
    return override.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  }

  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const rawHost = forwardedHost || c.req.header('host') || 'localhost';
  // Only a plain host:port is accepted. An arbitrary `X-Forwarded-Host` value
  // would otherwise let a client point the ws URL at a host of its choosing.
  const host = /^[A-Za-z0-9._-]+(:\d{1,5})?$/.test(rawHost) ? rawHost : 'localhost';

  // `X-Forwarded-Proto` is the only reliable scheme signal behind a proxy
  // (both nginx and Caddy set it). Without it we fall back to plain http/ws,
  // and a deployment that terminates TLS ITSELF must set PUBLIC_BASE_URL —
  // otherwise the client gets a `ws://` URL, which a browser refuses to open
  // from an https page. The example configs carry that variable for exactly
  // this reason.
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = forwardedProto ?? 'http';

  return proto === 'https' ? `wss://${host}` : `ws://${host}`;
}
