/**
 * Per-auth-mode required fields for the connector drawer.
 *
 * The console's job is to decide *how* a connector is verified, not to hold
 * anybody's credential. `user-oauth` therefore requires nothing at all: what
 * the admin leaves empty, the desktop discovers from the MCP server URL
 * (RFC 8414 / RFC 9728) and, when no client is pinned, registers itself
 * (RFC 7591). Anything the admin does fill wins over the discovered value.
 * The org-credential modes (`shared-key`, and the retired `client-creds`)
 * still collect their secret because they are reserved for a future
 * server-side gateway; the drawer says so.
 *
 * Pure: no i18n, no DOM. `ConnectorDrawer` maps the returned field key to a
 * label so the rules can be tested without rendering the drawer.
 */

import type { AuthMode6 } from '../../api/connectors';

/** The authConfig sub-fields the drawer collects as text. */
export interface AuthFieldValues {
  apiKey: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
}

export type AuthFieldKey = keyof AuthFieldValues;

/** Stored (masked, already saved) secrets that a blank input may keep. */
export interface StoredSecrets {
  apiKey: boolean;
  clientSecret: boolean;
}

/** i18n key for each field, so the drawer can label the error. */
export const AUTH_FIELD_LABEL_KEY: Record<AuthFieldKey, string> = {
  apiKey: 'mcpDrawer.auth.orgApiKey',
  clientId: 'mcpDrawer.auth.clientId',
  clientSecret: 'mcpDrawer.auth.clientSecret',
  authorizeUrl: 'mcpDrawer.auth.authorizeUrl',
  tokenUrl: 'mcpDrawer.auth.tokenUrl',
};

const has = (v: string): boolean => v.trim().length > 0;

/** The first field still missing for `authMode`, or null when the mode is
 *  complete. Mirrors the server's `missingAuthField` (mcpConnectors.ts). */
export function missingAuthField(
  authMode: AuthMode6,
  values: AuthFieldValues,
  stored: StoredSecrets,
): AuthFieldKey | null {
  switch (authMode) {
    case 'none':
    case 'user-key':
      return null;
    case 'shared-key':
      return has(values.apiKey) || stored.apiKey ? null : 'apiKey';
    case 'user-oauth':
      // Deliberately empty: all three are optional overrides of what the
      // desktop discovers and registers on its own.
      return null;
    case 'client-creds':
      if (!has(values.clientId)) return 'clientId';
      if (!has(values.tokenUrl)) return 'tokenUrl';
      return has(values.clientSecret) || stored.clientSecret ? null : 'clientSecret';
    default:
      return null;
  }
}

/** Loopback hosts are exempt from the https rule for the org key: the key is
 *  injected by the enterprise server, and on loopback it never leaves the
 *  machine. Mirrors `isUpstreamAddressAllowed` in server mcpGateway.ts — the
 *  console and the gateway must agree, or the console lets an admin publish a
 *  connector the gateway then refuses at every call. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Would this connector send the organization key over the wire in the clear?
 *  Only `shared-key` has an org key; a blank or unparseable URL is not judged
 *  here (the required-field rules already cover it). */
export function orgKeyUrlIsInsecure(authMode: string, rawUrl: string): boolean {
  if (authMode !== 'shared-key') return false;
  const url = rawUrl.trim();
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return false;
  // `URL.hostname` keeps a bracketed IPv6 literal (`[::1]`), so unwrap it.
  return !LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, ''));
}
