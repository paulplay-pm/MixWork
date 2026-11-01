import { describe, expect, test } from 'vitest';

import {
  normalizeTimeoutSeconds,
  readTimeoutSeconds,
  timeoutAuthConfigEntry,
  TIMEOUT_MAX,
  TIMEOUT_MIN,
} from '../../../src/pages/mcpManage/connectorRuntimeOptions';

describe('normalizeTimeoutSeconds', () => {
  test('an empty value means "use the runtime default" — nothing is stored', () => {
    expect(normalizeTimeoutSeconds('')).toBeUndefined();
    expect(normalizeTimeoutSeconds(undefined)).toBeUndefined();
    expect(normalizeTimeoutSeconds(null)).toBeUndefined();
  });

  test('a value in range is kept as a whole number of seconds', () => {
    expect(normalizeTimeoutSeconds(45)).toBe(45);
    expect(normalizeTimeoutSeconds(45.6)).toBe(46);
  });

  test('out-of-range values are clamped, not rejected', () => {
    expect(normalizeTimeoutSeconds(1)).toBe(TIMEOUT_MIN);
    expect(normalizeTimeoutSeconds(9999)).toBe(TIMEOUT_MAX);
  });

  test('nonsense is treated as "not set" rather than stored', () => {
    expect(normalizeTimeoutSeconds(0)).toBeUndefined();
    expect(normalizeTimeoutSeconds(-10)).toBeUndefined();
    expect(normalizeTimeoutSeconds(Number.NaN)).toBeUndefined();
  });
});

describe('readTimeoutSeconds', () => {
  test('a stored timeout comes back as a number', () => {
    expect(readTimeoutSeconds({ timeoutSeconds: 90 })).toBe(90);
  });

  test('nothing stored means an empty field', () => {
    expect(readTimeoutSeconds({})).toBe('');
    expect(readTimeoutSeconds({ timeoutSeconds: 0 })).toBe('');
    expect(readTimeoutSeconds({ timeoutSeconds: 'sixty' })).toBe('');
  });
});

describe('timeoutAuthConfigEntry', () => {
  test('a timeout travels as its number of seconds', () => {
    expect(timeoutAuthConfigEntry(90)).toBe(90);
  });

  test('an emptied field travels as an explicit null', () => {
    // The server deletes a stored field whose incoming value is null, so
    // "use the runtime default" actually clears a timeout the admin set
    // earlier. Omitting the key would keep the old value.
    expect(timeoutAuthConfigEntry('')).toBeNull();
    expect(timeoutAuthConfigEntry(null)).toBeNull();
    expect(timeoutAuthConfigEntry(undefined)).toBeNull();
    expect(timeoutAuthConfigEntry(0)).toBeNull();
  });
});
