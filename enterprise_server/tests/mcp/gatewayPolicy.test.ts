import { describe, expect, test } from 'vitest';

import { toolAllowedByPolicy } from '../../src/mcp/gatewayPolicy';
import type { ToolEntry } from '../../src/models/connectorView';

const t = (name: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({
  name,
  enabled: true,
  ...extra,
});

describe('toolAllowedByPolicy', () => {
  test('a connector that was never probed denies every tool', () => {
    expect(toolAllowedByPolicy([], 'create_lead')).toBe(false);
  });

  test('every entry removed denies every tool', () => {
    expect(toolAllowedByPolicy([t('a', { removed: true })], 'a')).toBe(false);
  });

  test('an enabled live tool is allowed, a disabled one is not', () => {
    expect(toolAllowedByPolicy([t('a'), t('b', { enabled: false })], 'a')).toBe(true);
    expect(toolAllowedByPolicy([t('a'), t('b', { enabled: false })], 'b')).toBe(false);
  });

  test('all live tools enabled allows each of them', () => {
    expect(toolAllowedByPolicy([t('a', { syncedAt: 'x' }), t('b', { syncedAt: 'x' })], 'b')).toBe(
      true,
    );
  });

  test('a hand-declared list is a whitelist', () => {
    const tools = [t('a'), t('b', { enabled: false })];
    expect(toolAllowedByPolicy(tools, 'a')).toBe(true);
    expect(toolAllowedByPolicy(tools, 'b')).toBe(false);
    expect(toolAllowedByPolicy(tools, 'never-declared')).toBe(false);
  });

  test('every tool disabled denies every tool', () => {
    expect(toolAllowedByPolicy([t('a', { enabled: false })], 'a')).toBe(false);
  });
});
