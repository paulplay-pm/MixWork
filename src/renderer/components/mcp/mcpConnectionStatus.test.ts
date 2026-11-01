import { describe, expect, test } from 'vitest';

import { connectedTools, connectionLabelKey } from './mcpConnectionStatus';

describe('connectionLabelKey', () => {
  test('a disabled server is never reported as connected or failed', () => {
    expect(connectionLabelKey(false, { kind: 'idle' })).toBe('mcpDetailConnectionDisabled');
    expect(
      connectionLabelKey(false, {
        kind: 'done',
        outcome: { ok: true, status: 'ok', tools: [], latencyMs: 1 },
      }),
    ).toBe('mcpDetailConnectionDisabled');
  });

  test('distinguishes checking, connected, expired authorization and failure', () => {
    expect(connectionLabelKey(true, { kind: 'idle' })).toBe('mcpDetailConnectionUnknown');
    expect(connectionLabelKey(true, { kind: 'loading' })).toBe('mcpDetailConnectionChecking');
    expect(
      connectionLabelKey(true, {
        kind: 'done',
        outcome: { ok: true, status: 'ok', tools: [{ name: 'a' }], latencyMs: 5 },
      }),
    ).toBe('mcpDetailConnectionOk');
    expect(
      connectionLabelKey(true, {
        kind: 'done',
        outcome: { ok: false, status: 'unauthorized', tools: [], latencyMs: 5, error: 'HTTP 401' },
      }),
    ).toBe('mcpDetailConnectionUnauthorized');
    expect(
      connectionLabelKey(true, {
        kind: 'done',
        outcome: { ok: false, status: 'connect-error', tools: [], latencyMs: 5, error: 'ECONNREFUSED' },
      }),
    ).toBe('mcpDetailConnectionFailed');
  });
});

describe('connectedTools', () => {
  test('returns null while the check is still running', () => {
    expect(connectedTools({ kind: 'idle' })).toBeNull();
    expect(connectedTools({ kind: 'loading' })).toBeNull();
  });

  test('carries the tools on success and nothing on failure', () => {
    expect(
      connectedTools({
        kind: 'done',
        outcome: { ok: true, status: 'ok', tools: [{ name: 'create_lead' }], latencyMs: 1 },
      }),
    ).toEqual([{ name: 'create_lead' }]);
    expect(
      connectedTools({
        kind: 'done',
        outcome: { ok: true, status: 'ok', tools: [], latencyMs: 1 },
      }),
    ).toEqual([]);
    expect(
      connectedTools({
        kind: 'done',
        outcome: { ok: false, status: 'unauthorized', tools: [], latencyMs: 1, error: 'HTTP 401' },
      }),
    ).toBeNull();
  });
});
