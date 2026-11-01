import { describe, expect, test } from 'vitest';

import { McpAuthMethod, McpAuthStatus } from '../../../shared/mcp/constants';
import type { McpServerConfig, McpToolListOutcome } from '../../types/mcp';
import {
  connectorNeedsCredential,
  connectorRowState,
  ConnectorRowStatus,
  connectorStatusLabelKey,
} from './connectorPickerState';

const server = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'srv-1',
  name: '纷享销客',
  description: '',
  enabled: true,
  transportType: 'http',
  url: 'https://crm.example.com/mcp',
  isBuiltIn: false,
  authMethod: McpAuthMethod.ApiKey,
  authStatus: McpAuthStatus.Authenticated,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const outcome = (status: McpToolListOutcome['status']): McpToolListOutcome => ({
  ok: status === 'ok',
  status,
  tools: [],
  latencyMs: 10,
});

describe('connectorRowState', () => {
  test('an enabled connector that answers is just on', () => {
    const state = connectorRowState(server(), outcome('ok'));
    expect(state.status).toBe(ConnectorRowStatus.Connected);
    expect(state.canToggle).toBe(true);
    expect(state.canConnect).toBe(false);
  });

  test('a refused credential offers a renewal, not a first connection', () => {
    const state = connectorRowState(server(), outcome('unauthorized'));
    expect(state.status).toBe(ConnectorRowStatus.AuthExpired);
    expect(state.canConnect).toBe(true);
    expect(state.connectMode).toBe('reauthorize');
    // The switch stays: the connector is still enabled, it just cannot be used.
    expect(state.canToggle).toBe(true);
  });

  test('a credential refused on a connector that is off offers a first connection', () => {
    const state = connectorRowState(server({ enabled: false }), outcome('unauthorized'));
    expect(state.status).toBe(ConnectorRowStatus.AuthExpired);
    expect(state.connectMode).toBe('connect');
  });

  test('an installed connector with no credential cannot be switched on yet', () => {
    const state = connectorRowState(
      server({ enabled: false, authStatus: McpAuthStatus.NeedsAuth }),
      undefined,
    );
    expect(state.status).toBe(ConnectorRowStatus.NeedsCredential);
    expect(state.canConnect).toBe(true);
    expect(state.canToggle).toBe(false);
  });

  test('a stored auth error outranks "on" even before a live probe', () => {
    // The stored status only records the last probe and may be hours old, but
    // a known-broken credential must never read as healthy.
    const state = connectorRowState(server({ authStatus: McpAuthStatus.AuthError }), undefined);
    expect(state.status).toBe(ConnectorRowStatus.AuthExpired);
    expect(state.canConnect).toBe(true);
  });

  test('an unreachable endpoint offers a connect action rather than a dead end', () => {
    // "Not connected" with nothing to click leaves the user stuck; the modal
    // re-probes and reports what actually failed.
    const state = connectorRowState(server(), outcome('connect-error'));
    expect(state.status).toBe(ConnectorRowStatus.NotConnected);
    expect(state.canToggle).toBe(true);
    expect(state.canConnect).toBe(true);
  });

  test('an off connector is a switch and nothing else', () => {
    const state = connectorRowState(server({ enabled: false }), undefined);
    expect(state.status).toBe(ConnectorRowStatus.Disabled);
    expect(state.canToggle).toBe(true);
    expect(state.canConnect).toBe(false);
  });

  test('a connector with no authentication is never asked for a credential', () => {
    expect(connectorNeedsCredential(server({ authMethod: McpAuthMethod.None }))).toBe(false);
    expect(connectorNeedsCredential(server({ authMethod: McpAuthMethod.Bearer }))).toBe(true);
  });
});

describe('connectorStatusLabelKey', () => {
  test('says something only when there is something to say', () => {
    expect(connectorStatusLabelKey(connectorRowState(server(), outcome('ok')))).toBeNull();
    expect(connectorStatusLabelKey(connectorRowState(server({ enabled: false }), undefined))).toBeNull();
    expect(connectorStatusLabelKey(connectorRowState(server(), outcome('unauthorized'))))
      .toBe('mcpConnectorAuthExpired');
    expect(connectorStatusLabelKey(connectorRowState(server(), outcome('connect-error'))))
      .toBe('mcpDetailConnectionFailed');
  });
});
