import { describe, expect, test } from 'vitest';

import { sourceLabelKey } from './mcpSource';

describe('sourceLabelKey', () => {
  test('an enterprise connector reports the enterprise marketplace even though it is also flagged built-in', () => {
    expect(
      sourceLabelKey({ serverKey: 'crm-mcp', isBuiltIn: true, registryId: 'bf61d174-8c2f-4959-816c-c21e44939ccf' }),
    ).toBe('mcpSourceEnterprise');
  });

  test('a built-in catalog entry reports the built-in marketplace', () => {
    expect(sourceLabelKey({ isBuiltIn: true })).toBe('mcpSourceMarketplace');
    expect(sourceLabelKey({ registryId: 'qcc-company' })).toBe('mcpSourceMarketplace');
  });

  test('a hand-configured server reports custom', () => {
    expect(sourceLabelKey({})).toBe('mcpCustom');
    expect(sourceLabelKey({ isBuiltIn: false, registryId: null, serverKey: '' })).toBe('mcpCustom');
  });
});
