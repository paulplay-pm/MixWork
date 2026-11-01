import { ConnectorAuthMode, McpAuthMethod } from '../../../shared/mcp/constants';
import type { McpEnterpriseMarketServer } from '../../types/mcp';

/** `shared-key`: the org holds one key, and the enterprise gateway injects it
 *  on every call. The member holds nothing — but the connector IS installable:
 *  the desktop dials `ALL /mcp/gateway/:serverKey` with its own service
 *  token. */
export function isGatewayAuthMode(mode?: string | null): boolean {
  return mode === ConnectorAuthMode.SharedKey;
}

/** `client-creds`: the org holds a client secret that nothing injects yet, so
 *  no desktop can use the connector. Its card offers no install. */
export function isRetiredAuthMode(mode?: string | null): boolean {
  return mode === ConnectorAuthMode.ClientCreds;
}

/**
 * Is this local record a gateway connector?
 *
 * Records installed after the mode became persisted carry it themselves. A
 * record installed before that has only `serverKey`, so it is matched against
 * the marketplace's current catalog — the entry the user would otherwise be
 * offered again with an install button they cannot satisfy.
 */
export function isGatewayServer(
  record: { enterpriseAuthMode?: string | null; serverKey?: string | null },
  catalogAuthModeByServerKey: Record<string, string> = {},
): boolean {
  if (record.enterpriseAuthMode) return isGatewayAuthMode(record.enterpriseAuthMode);
  if (record.serverKey) return isGatewayAuthMode(catalogAuthModeByServerKey[record.serverKey]);
  return false;
}

/**
 * Is this local record a retired org-credential connector? Same two-step
 * lookup as {@link isGatewayServer}, against the retired mode instead.
 */
export function isRetiredServer(
  record: { enterpriseAuthMode?: string | null; serverKey?: string | null },
  catalogAuthModeByServerKey: Record<string, string> = {},
): boolean {
  if (record.enterpriseAuthMode) return isRetiredAuthMode(record.enterpriseAuthMode);
  if (record.serverKey) return isRetiredAuthMode(catalogAuthModeByServerKey[record.serverKey]);
  return false;
}

/**
 * Map an enterprise connector's wire `authMode` (6 modes) to the local
 * `McpAuthMethod` the install form should pre-fill. The downstream
 * `deriveAuthStatus` (mcpStore) then turns a non-None method with no
 * credential into the `needs-auth` state (orange dot + Connect button), which
 * is the spec's 待配置 affordance.
 *
 * - User-credential direct-link modes map to their real method:
 *   `user-oauth`/`sso` → OAuth (both drive the same generic PKCE flow off the
 *   connector's own endpoints), `user-key` → ApiKey.
 * - Org-credential modes (shared-key / client-creds) map to None because the
 *   desktop has no credential to offer: it used to map to Bearer, which opened
 *   an authorize dialog asking the member for a token only the org holds.
 *   `shared-key` is installable now — the enterprise gateway injects the key
 *   (see `isGatewayAuthMode`); `client-creds` is still refused
 *   (`isRetiredAuthMode`).
 */
export function mapEnterpriseAuthModeToMcpAuthMethod(
  authMode: McpEnterpriseMarketServer['authMode']
): McpAuthMethod {
  switch (authMode) {
    case 'none':
      return McpAuthMethod.None;
    case 'user-key':
      return McpAuthMethod.ApiKey;
    case 'user-oauth':
      return McpAuthMethod.OAuth;
    case 'sso':
      return McpAuthMethod.OAuth;
    case 'shared-key':
    case 'client-creds':
      return McpAuthMethod.None;
    default:
      return McpAuthMethod.None;
  }
}

/**
 * The label for an org-defined auth mode, in the org's own vocabulary.
 *
 * The desktop's `McpAuthMethod` cannot express what the org bought: a
 * `shared-key` connector is "no credential on this machine" locally, but to
 * the member it is "the organization holds a key for this connector". Showing
 * "none" there reads as "this connector needs no authentication", which is
 * the opposite of the truth.
 *
 * Returns null for a mode this build does not know, so the caller can fall
 * back to the generic method label instead of inventing one.
 */
export function enterpriseAuthModeLabelKey(mode?: string | null): string | null {
  switch (mode) {
    case ConnectorAuthMode.SharedKey:
      return 'mcpEnterpriseAuthModeSharedKey';
    case ConnectorAuthMode.ClientCreds:
      return 'mcpEnterpriseAuthModeClientCreds';
    case ConnectorAuthMode.UserKey:
      return 'mcpEnterpriseAuthModeUserKey';
    case ConnectorAuthMode.UserOauth:
    case ConnectorAuthMode.Sso:
      return 'mcpEnterpriseAuthModeOAuth';
    case ConnectorAuthMode.None:
      return 'mcpEnterpriseAuthModeNone';
    default:
      return null;
  }
}

/**
 * The label for a local auth method, for the rows that still show one.
 *
 * The org's own vocabulary (`enterpriseAuthModeLabelKey`) is preferred
 * wherever it exists; this is the fallback for a connector whose mode the
 * desktop knows only locally.
 */
export function authMethodLabelKey(method: McpAuthMethod): string {
  switch (method) {
    case McpAuthMethod.Bearer:
      return 'mcpAuthMethodBearer';
    case McpAuthMethod.ApiKey:
      return 'mcpAuthMethodApiKey';
    case McpAuthMethod.OAuth:
      return 'mcpAuthMethodOAuth';
    default:
      return 'mcpAuthMethodNone';
  }
}
