import { describe, expect, test } from 'vitest';

import { orgKeyUrlIsInsecure } from '../../../src/pages/mcpManage/connectorValidation';

describe('orgKeyUrlIsInsecure', () => {
  test('is false for every mode that has no org key', () => {
    expect(orgKeyUrlIsInsecure('user-key', 'http://example.com/mcp')).toBe(false);
    expect(orgKeyUrlIsInsecure('none', 'http://example.com/mcp')).toBe(false);
  });

  test('is false for https, and for a blank url', () => {
    expect(orgKeyUrlIsInsecure('shared-key', 'https://example.com/mcp')).toBe(false);
    expect(orgKeyUrlIsInsecure('shared-key', '')).toBe(false);
  });

  test('is true for http on a routable host', () => {
    expect(orgKeyUrlIsInsecure('shared-key', 'http://example.com/mcp')).toBe(true);
    expect(orgKeyUrlIsInsecure('shared-key', 'http://10.0.0.5:8080/mcp')).toBe(true);
  });

  test('is false for loopback, which the gateway also allows', () => {
    expect(orgKeyUrlIsInsecure('shared-key', 'http://localhost:8931/mcp')).toBe(false);
    expect(orgKeyUrlIsInsecure('shared-key', 'http://127.0.0.1:8931/mcp')).toBe(false);
    expect(orgKeyUrlIsInsecure('shared-key', 'http://[::1]:8931/mcp')).toBe(false);
  });
});
