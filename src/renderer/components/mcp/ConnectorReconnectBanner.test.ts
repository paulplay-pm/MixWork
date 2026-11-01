import { describe, expect, test } from 'vitest';

import { McpAuthMethod, McpAuthStatus } from '../../../shared/mcp/constants';
import type { McpServerConfig, McpToolListOutcome } from '../../types/mcp';
import { expiredConnectors } from './ConnectorReconnectBanner';

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

describe('expiredConnectors', () => {
  test('reports an enabled connector whose credential was refused', () => {
    const result = expiredConnectors([server()], { 'srv-1': outcome('unauthorized') });
    expect(result.map((item) => item.id)).toEqual(['srv-1']);
  });

  test('ignores a switched-off connector', () => {
    // A disabled connector is not in the model's tool list, so a dead
    // credential on it breaks nothing and must not nag the user.
    const result = expiredConnectors(
      [server({ enabled: false })],
      { 'srv-1': outcome('unauthorized') },
    );
    expect(result).toEqual([]);
  });

  test('ignores a healthy connector', () => {
    expect(expiredConnectors([server()], { 'srv-1': outcome('ok') })).toEqual([]);
  });

  test('ignores a connector no probe has answered for yet', () => {
    expect(expiredConnectors([server()], {})).toEqual([]);
  });

  test('a probe that could not connect is not an expired credential', () => {
    // "Unreachable" needs a different fix from "re-authorize"; the banner
    // only offers the latter.
    expect(expiredConnectors([server()], { 'srv-1': outcome('connect-error') })).toEqual([]);
  });
});
