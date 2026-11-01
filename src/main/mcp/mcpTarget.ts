import { ConnectorConsumption } from '../../shared/mcp/constants';
import { getServerApiBaseUrl } from '../libs/endpoints';

/** A dialable MCP endpoint plus the headers it needs. */
export interface McpTarget {
  url: string;
  headers: Record<string, string>;
}

/** The enterprise gateway's address for one connector. */
export function gatewayUrlFor(baseUrl: string, serverKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/mcp/gateway/${encodeURIComponent(serverKey)}`;
}

/**
 * The enterprise server's base URL, or null when this build has none.
 *
 * `getServerApiBaseUrl()` throws when `ENTERPRISE_SERVER_URL` is unset — the
 * normal state of a consumer build and of local dev — so the callers that
 * merely want to know whether a gateway connector is usable must not have to
 * catch.
 */
export function enterpriseBaseUrlOrNull(): string | null {
  try {
    const url = getServerApiBaseUrl();
    return url ? url.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/**
 * Where a connector record should actually be dialed.
 *
 * Two shapes: a direct connector dials its own URL (unchanged behavior), and a
 * gateway connector dials the enterprise gateway with its service token. A
 * gateway record that cannot produce a gateway target returns `null` rather
 * than falling back to its own URL — the org key lives server-side, so a
 * direct dial would call the vendor with no authorization at all, which fails
 * in a way that looks like a vendor outage instead of a missing credential.
 *
 * Synchronous on purpose: the token is on the local record, not in the
 * session, so callers can resolve a target inside a config build.
 */
export function resolveMcpTarget(
  record: {
    url?: string;
    headers?: Record<string, string>;
    consumption?: ConnectorConsumption;
    serverKey?: string;
    gatewayToken?: string;
  },
  ctx: { enterpriseBaseUrl: string | null },
): McpTarget | null {
  if (record.consumption !== ConnectorConsumption.Gateway) {
    if (!record.url) return null;
    return { url: record.url, headers: record.headers ?? {} };
  }
  if (!ctx.enterpriseBaseUrl || !record.serverKey || !record.gatewayToken) return null;
  return {
    url: gatewayUrlFor(ctx.enterpriseBaseUrl, record.serverKey),
    headers: { authorization: `McpGateway ${record.gatewayToken}` },
  };
}
