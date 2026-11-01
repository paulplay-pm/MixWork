import { McpAuthMethod, McpAuthStatus } from '../../../shared/mcp/constants';
import type { McpServerConfig, McpToolListOutcome } from '../../types/mcp';

/**
 * What a connector row in the picker is showing.
 *
 * The picker is where a user finds out that a connector is switched on but
 * its credential has expired, so the row has to say more than "on".
 */
export const ConnectorRowStatus = {
  /** Enabled, and the endpoint answered when it was asked. */
  Connected: 'connected',
  /** The credential was refused — the user has to authorize again. */
  AuthExpired: 'auth-expired',
  /** Enabled, but the endpoint could not be reached. */
  NotConnected: 'not-connected',
  /** Installed, but it never got a credential. */
  NeedsCredential: 'needs-credential',
  /** Installed and switched off. */
  Disabled: 'disabled',
} as const;
export type ConnectorRowStatus = typeof ConnectorRowStatus[keyof typeof ConnectorRowStatus];

export interface ConnectorRowState {
  status: ConnectorRowStatus;
  /** The row offers a "connect" action: authorize, or authorize again. */
  canConnect: boolean;
  /** The row offers the enable switch. */
  canToggle: boolean;
  /** Whether the authorize action is a first authorization or a renewal. */
  connectMode: 'connect' | 'reauthorize';
}

/**
 * The live probe's verdict on one connector.
 *
 * A probe is a real round-trip to the endpoint, so it is only available
 * once one has run; before that the stored `authStatus` is the only
 * evidence, and it may be hours old.
 */
function probeStatus(outcome: McpToolListOutcome | undefined): McpToolListOutcome['status'] | null {
  if (!outcome) return null;
  return outcome.status;
}

/**
 * How a connector row should read.
 *
 * The order matters: a refused credential outranks everything, because it
 * is the one state the user can fix from this row.
 */
export function connectorRowState(
  server: McpServerConfig,
  outcome: McpToolListOutcome | undefined,
): ConnectorRowState {
  const live = probeStatus(outcome);
  const storedAuthBroken =
    server.authStatus === McpAuthStatus.NeedsAuth || server.authStatus === McpAuthStatus.AuthError;

  if (live === 'unauthorized') {
    return {
      status: ConnectorRowStatus.AuthExpired,
      canConnect: true,
      canToggle: true,
      connectMode: server.enabled ? 'reauthorize' : 'connect',
    };
  }

  if (live === 'missing-credential' || (storedAuthBroken && !server.enabled)) {
    return {
      status: ConnectorRowStatus.NeedsCredential,
      canConnect: true,
      canToggle: false,
      connectMode: 'connect',
    };
  }

  if (storedAuthBroken) {
    // Enabled, but the saved credential is known to be broken and no live
    // probe has run: treat it as expired rather than healthy.
    return {
      status: ConnectorRowStatus.AuthExpired,
      canConnect: true,
      canToggle: true,
      connectMode: 'reauthorize',
    };
  }

  if (!server.enabled) {
    return {
      status: ConnectorRowStatus.Disabled,
      canConnect: false,
      canToggle: true,
      connectMode: 'connect',
    };
  }

  if (live === 'connect-error') {
    // Enabled but unreachable. Offer the connect action even though the
    // problem may be the network rather than the credential: the modal
    // re-probes on save and says what failed, and a row that reads
    // "not connected" with no way to act on it is a dead end.
    return {
      status: ConnectorRowStatus.NotConnected,
      canConnect: true,
      canToggle: true,
      connectMode: 'connect',
    };
  }

  return {
    status: ConnectorRowStatus.Connected,
    canConnect: false,
    canToggle: true,
    connectMode: 'connect',
  };
}

/**
 * Whether the connector needs a credential of its own.
 *
 * A connector with no authentication at all is always "ready"; the rest
 * need one before they can be switched on.
 */
export function connectorNeedsCredential(server: McpServerConfig): boolean {
  return server.authMethod !== McpAuthMethod.None;
}

/**
 * The status text a row shows next to its name, or null when the row has
 * nothing to report.
 */
export function connectorStatusLabelKey(state: ConnectorRowState): string | null {
  switch (state.status) {
    case ConnectorRowStatus.AuthExpired:
      return 'mcpConnectorAuthExpired';
    case ConnectorRowStatus.NotConnected:
      return 'mcpDetailConnectionFailed';
    case ConnectorRowStatus.NeedsCredential:
      return 'mcpConnectorNeedsCredential';
    default:
      return null;
  }
}
