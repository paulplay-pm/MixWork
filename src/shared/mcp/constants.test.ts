import { expect, test } from 'vitest';

import { ConnectorConsumption } from './constants';

// The desktop and the enterprise server agree on these two strings or the
// marketplace's `consumption` field reads as garbage and a gateway connector
// silently falls back to dialing its upstream — the exact failure the field
// exists to prevent.
test('the consumption discriminants match the enterprise wire', () => {
  expect(ConnectorConsumption.Direct).toBe('direct');
  expect(ConnectorConsumption.Gateway).toBe('gateway');
});
