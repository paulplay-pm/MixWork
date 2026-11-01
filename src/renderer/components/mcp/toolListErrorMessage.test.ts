import { describe, expect, test } from 'vitest';

import { McpGatewayError } from '../../../shared/mcp/constants';
import type { McpToolListOutcome } from '../../types/mcp';
import { toolListErrorKey } from './toolListErrorMessage';

const failed = (overrides: Partial<McpToolListOutcome> = {}): McpToolListOutcome => ({
  ok: false,
  status: 'connect-error',
  tools: [],
  latencyMs: 12,
  error: 'initialize failed: HTTP 502',
  ...overrides,
});

describe('toolListErrorKey', () => {
  test('a dead org key asks the member to call an admin', () => {
    expect(toolListErrorKey(failed({ errorCode: McpGatewayError.UpstreamUnauthorized }), true))
      .toBe('mcpGatewayErrorUpstreamUnauthorized');
  });

  test('a connector the caller may not use says so', () => {
    expect(toolListErrorKey(failed({ errorCode: McpGatewayError.Forbidden }), true))
      .toBe('mcpGatewayErrorForbidden');
  });

  test('a removed connector points at the marketplace', () => {
    expect(toolListErrorKey(failed({ errorCode: McpGatewayError.NotFound }), true))
      .toBe('mcpGatewayErrorNotFound');
  });

  test('both "not a transport for the gateway" codes share one sentence', () => {
    expect(toolListErrorKey(failed({ errorCode: McpGatewayError.UnsupportedTransport }), true))
      .toBe('mcpGatewayErrorUnsupportedTransport');
    expect(toolListErrorKey(failed({ errorCode: McpGatewayError.NotGatewayMode }), true))
      .toBe('mcpGatewayErrorUnsupportedTransport');
  });

  test('an insecure upstream and a dead one are different failures', () => {
    expect(toolListErrorKey(failed({ errorCode: McpGatewayError.UpstreamInsecure }), true))
      .toBe('mcpGatewayErrorUpstreamInsecure');
    expect(toolListErrorKey(failed({ errorCode: McpGatewayError.UpstreamFailed }), true))
      .toBe('mcpGatewayErrorUpstreamFailed');
  });

  test('a gateway record with no usable credential says "sign in again"', () => {
    expect(toolListErrorKey(failed({ status: 'missing-credential' }), true))
      .toBe('mcpGatewayErrorCredentialUnavailable');
  });

  test('an unknown code keeps the raw reason instead of guessing', () => {
    expect(toolListErrorKey(failed({ errorCode: 'some_future_code' }), true)).toBeNull();
  });

  test('a direct connector is never translated through the gateway vocabulary', () => {
    expect(toolListErrorKey(failed({ errorCode: McpGatewayError.UpstreamUnauthorized }), false))
      .toBeNull();
    expect(toolListErrorKey(failed({ status: 'missing-credential', error: 'Missing URL' }), false))
      .toBeNull();
  });
});
