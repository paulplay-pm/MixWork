import type { AuthMode6 } from '../../api/connectors';

/**
 * Which auth modes the console offers, and how the ones it no longer offers
 * still open.
 *
 * The rule the product settled on: the org declares *how* a connector
 * authenticates, the member authorizes on their own desktop. A mode whose
 * credential belongs to the org cannot work until a gateway exists to inject
 * one, so offering it only hands the admin a switch that does nothing visible.
 */

/** Modes an admin can pick for a connector today, in display order. */
export const SELECTABLE_AUTH_MODES: AuthMode6[] = [
  'none',
  'shared-key',
  'user-key',
  'user-oauth',
];

/**
 * Values that still exist on stored connectors but are no longer offered:
 *
 * - `client-creds` is retired — an org-level OAuth credential with no path to
 *   the desktop.
 * - `sso` is folded into `user-oauth` — the same PKCE flow against the same
 *   three endpoints; only the `sso*` field prefix differed.
 */
export const DATA_ONLY_AUTH_MODES: AuthMode6[] = ['client-creds', 'sso'];

export function isSelectableAuthMode(mode: AuthMode6): boolean {
  return SELECTABLE_AUTH_MODES.includes(mode);
}

/** A legacy `sso` connector opens as `user-oauth` — one mode instead of two. */
export function normalizeLegacyAuthMode(mode: AuthMode6): AuthMode6 {
  return mode === 'sso' ? 'user-oauth' : mode;
}

/**
 * Whether the enterprise server can list this connector's tools itself.
 *
 * It can only do that by running a real MCP handshake, which needs a
 * credential the org holds: `none` needs none and `shared-key` has the
 * org's key. The member-credential modes have nothing to authenticate with
 * (the member brings their own key, or authorizes through PKCE), so their
 * tool list has to be declared by hand.
 */
export function serverCanDiscoverTools(mode: AuthMode6): boolean {
  return mode === 'none' || mode === 'shared-key';
}

export interface OAuthFieldValues {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
}

/**
 * Read the OAuth fields a stored `authConfig` carries, whichever prefix its
 * mode used. Bare values win; the `sso*` spelling is the legacy one.
 */
export function readOAuthFields(
  authMode: AuthMode6,
  authConfig: Record<string, unknown>,
): OAuthFieldValues {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const legacy = authMode === 'sso';
  const pick = (bare: string, prefixed: string): string =>
    str(authConfig[bare]) || (legacy ? str(authConfig[prefixed]) : '');
  const bareScopes = list(authConfig.scopes);
  return {
    clientId: pick('clientId', 'ssoClientId'),
    authorizeUrl: pick('authorizeUrl', 'ssoAuthorizeUrl'),
    tokenUrl: pick('tokenUrl', 'ssoTokenUrl'),
    scopes: bareScopes.length > 0 ? bareScopes : legacy ? list(authConfig.ssoScopes) : [],
  };
}
