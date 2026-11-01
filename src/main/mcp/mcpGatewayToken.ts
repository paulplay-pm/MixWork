import { ConnectorConsumption } from '../../shared/mcp/constants';
import { enterpriseClient } from '../auth/enterpriseClient';
import { sessionStorage } from '../auth/sessionStorage';

/** Refresh this far ahead of expiry. A gateway token lives 90 days; inside
 *  the last 15 the desktop mints a new one on the next config build, so an
 *  expiry can never land in the middle of a work session. */
export const GATEWAY_TOKEN_REFRESH_WINDOW_MS = 15 * 86_400_000;

export interface GatewayTokenResult {
  token: string;
  /** The member the token was minted for — the caller stores it so a later
   *  session can tell whether the token is still theirs. */
  owner: string;
  expiresAt: string;
}

/**
 * The token already stored on the record, but only when it is THIS member's.
 *
 * Callers need a fallback for the case `ensureGatewayToken` refuses to mint
 * (a transient failure during a config build, where dropping the connector
 * would restart OpenClaw and take away tools mid-conversation). That fallback
 * must never widen into "whatever token is on the record": a token minted for
 * another member is not a credential this session may use (§9.11), and a
 * signed-out app has no credential at all (§8.26).
 *
 * Returns null when signed out, when the record carries no token, or when the
 * token belongs to someone else.
 */
export function storedGatewayTokenForCurrentMember(record: {
  gatewayToken?: string;
  gatewayTokenOwner?: string;
}): string | null {
  const owner = sessionStorage.load()?.userId;
  if (!owner || !record.gatewayToken) return null;
  return record.gatewayTokenOwner === owner ? record.gatewayToken : null;
}

/**
 * The gateway token to dial this record with, minting a new one when needed.
 *
 * Reuse requires all three: a token, the same owner as the signed-in member,
 * and at least 15 days of life left. Everything else re-issues — in
 * particular a token belonging to another member, because "the token is on
 * this record" is not evidence that *this* member may use it.
 *
 * Returns null for a non-gateway record, a record with no server key, and a
 * signed-out app. Logged out is a normal state, not an error: the caller
 * skips the server rather than failing the whole config.
 *
 * Never writes. The caller persists what it gets, so there is exactly one
 * writer per call site and no hidden I/O inside a config build.
 */
export async function ensureGatewayToken(record: {
  serverKey?: string;
  consumption?: ConnectorConsumption;
  gatewayToken?: string;
  gatewayTokenOwner?: string;
  gatewayTokenExpiresAt?: string;
}): Promise<GatewayTokenResult | null> {
  if (record.consumption !== ConnectorConsumption.Gateway) return null;
  const serverKey = record.serverKey;
  if (!serverKey) return null;

  const owner = sessionStorage.load()?.userId;
  if (!owner) return null;

  const expiresAt = record.gatewayTokenExpiresAt ? Date.parse(record.gatewayTokenExpiresAt) : NaN;
  const reusable =
    !!record.gatewayToken &&
    record.gatewayTokenOwner === owner &&
    Number.isFinite(expiresAt) &&
    expiresAt - Date.now() >= GATEWAY_TOKEN_REFRESH_WINDOW_MS;
  if (reusable) {
    return { token: record.gatewayToken!, owner, expiresAt: record.gatewayTokenExpiresAt! };
  }

  const fresh = await enterpriseClient.issueGatewayToken(serverKey);
  return { token: fresh.token, owner, expiresAt: fresh.expiresAt };
}
