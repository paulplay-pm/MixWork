import {
  ConnectorAuthMode,
  ConnectorConsumption,
  McpAuthMethod,
} from '../../../shared/mcp/constants';
import {
  isGatewayAuthMode,
  isGatewayServer,
  isRetiredAuthMode,
  isRetiredServer,
  mapEnterpriseAuthModeToMcpAuthMethod,
} from './enterpriseAuthMode';

/** What an enterprise market card offers for one catalog entry. */
export const EnterpriseCardAction = {
  Install: 'install',
  Installed: 'installed',
  /** The org holds a secret nothing can inject yet — no install, and the card
   *  says why instead of offering a flow the member cannot finish. */
  Retired: 'retired',
} as const;
export type EnterpriseCardAction = typeof EnterpriseCardAction[keyof typeof EnterpriseCardAction];

export function enterpriseCardAction(args: {
  authMode?: string | null;
  installed: boolean;
}): EnterpriseCardAction {
  if (isRetiredAuthMode(args.authMode)) return EnterpriseCardAction.Retired;
  return args.installed ? EnterpriseCardAction.Installed : EnterpriseCardAction.Install;
}

/** The org-credential label an installed connector's card carries. */
export const EnterpriseOrgBadge = {
  /** `shared-key`: usable, dialed through the enterprise gateway. */
  Gateway: 'gateway',
  /** `client-creds`: installed but unusable until the gateway supports it. */
  Retired: 'retired',
} as const;
export type EnterpriseOrgBadge = typeof EnterpriseOrgBadge[keyof typeof EnterpriseOrgBadge];

/**
 * Which org-credential badge an installed card shows, if any.
 *
 * Gateway and retired are mutually exclusive per mode, so one function decides
 * instead of the card carrying two booleans and a ternary each.
 */
export function installedOrgBadge(
  record: { enterpriseAuthMode?: string | null; serverKey?: string | null },
  catalogAuthModeByServerKey: Record<string, string> = {},
): EnterpriseOrgBadge | null {
  if (isGatewayServer(record, catalogAuthModeByServerKey)) return EnterpriseOrgBadge.Gateway;
  if (isRetiredServer(record, catalogAuthModeByServerKey)) return EnterpriseOrgBadge.Retired;
  return null;
}

/**
 * Whether the org key is stored server-side for this connector.
 *
 * Only the catalog knows, and absence is not "configured": a member whose
 * catalog no longer lists the connector must still be told the key is
 * missing, because that is the state the connector is in.
 */
export function orgKeyReady(
  catalogEntry?: { orgCredentialReady?: boolean } | null,
): boolean {
  return catalogEntry?.orgCredentialReady === true;
}

/**
 * How the desktop reaches a catalog entry: the server's `consumption` when it
 * says, else derived from the mode.
 *
 * The field is newer than the gateway; a `shared-key` entry without it is
 * still gateway-scoped, and treating silence as `direct` would install a
 * connector that can only answer 401.
 */
export function consumptionForEntry(entry: {
  authMode?: string | null;
  consumption?: ConnectorConsumption;
}): ConnectorConsumption {
  if (entry.consumption) return entry.consumption;
  return isGatewayAuthMode(entry.authMode)
    ? ConnectorConsumption.Gateway
    : ConnectorConsumption.Direct;
}

/**
 * Whether the install form must show the URL read-only.
 *
 * A gateway connector's address is the enterprise gateway's. Editing it would
 * point the member at the upstream, which answers 401 — a safe failure, but an
 * unexplained one.
 */
export function gatewayUrlIsReadOnly(args: {
  entry?: { authMode?: string | null } | null;
  record?: { enterpriseAuthMode?: string | null; serverKey?: string | null } | null;
}): boolean {
  return isGatewayAuthMode(args.entry?.authMode) || isGatewayServer(args.record ?? {});
}

/**
 * Whether the form must show the auth method as fixed.
 *
 * For an enterprise connector the method is the org's decision, not the
 * member's: `shared-key` only works through the gateway, `user-key` means the
 * member fills the value of a header the admin named, `user-oauth` runs the
 * connector's own approval flow. A member who could switch it would install a
 * connector that dials with the wrong credential — or, worse, one that dials
 * with none at all.
 *
 * The member's own credential (the value under the method) stays editable:
 * that part is theirs.
 */
export function authMethodIsReadOnly(args: {
  entry?: { authMode?: string | null } | null;
  record?: { enterpriseAuthMode?: string | null; serverKey?: string | null } | null;
}): boolean {
  if (args.entry?.authMode) return true;
  const record = args.record;
  if (!record) return false;
  // A record installed before the mode was persisted still knows it came from
  // the org: it carries the server key.
  return !!record.enterpriseAuthMode || !!record.serverKey;
}

/**
 * The auth method the form shows for an enterprise connector, mapped to what
 * the desktop stores.
 *
 * The catalog is the authority while it is available; an installed record
 * keeps the mode it was installed with. Returns null when this is not an
 * enterprise connector, so the form keeps its own value.
 */
export function enterpriseAuthMethodForForm(args: {
  entry?: { authMode?: ConnectorAuthMode | null } | null;
  record?: { enterpriseAuthMode?: ConnectorAuthMode | null } | null;
}): McpAuthMethod | null {
  const mode = args.entry?.authMode ?? args.record?.enterpriseAuthMode;
  if (!mode) return null;
  return mapEnterpriseAuthModeToMcpAuthMethod(mode);
}
