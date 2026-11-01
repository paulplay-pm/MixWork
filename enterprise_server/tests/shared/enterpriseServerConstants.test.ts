import { describe, expect, test } from 'vitest';

import { AuditAction } from '../../src/shared/enterpriseServerConstants';

describe('AuditAction wire values', () => {
  test('the gateway call action is a lowercase snake_case id', () => {
    // Stored verbatim in `audit_events.action`; renaming it silently orphans
    // every row already written.
    expect(AuditAction.McpGatewayCall).toBe('mcp_gateway_call');
  });
});
