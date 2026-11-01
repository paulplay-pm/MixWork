import { afterEach, describe, expect, test } from 'vitest';

import { formatOrgDate, formatOrgHour } from '../../../src/analytics/datetime';
import { formatDelta, formatTokens } from '../../../src/components/dashboard/format';
import { setLang } from '../../../src/i18n';

describe('components/dashboard/format', () => {
  test.each([
    [999, 'zh', '999'],
    [1_000, 'zh', '1,000'],
    [18_240_000, 'zh', '1824.0 万'],
    [123_456_789_012, 'zh', '1234.6 亿'],
    [1_824_000, 'en', '1.8M'],
    [999, 'en', '999'],
    [1_500, 'en', '1.5K'],
    [2_400_000_000, 'en', '2.4B'],
  ] as const)('formatTokens(%i, %s) === %s', (n, lang, expected) => {
    expect(formatTokens(n, lang)).toBe(expected);
  });

  test('formatDelta returns new (not Infinity) when the previous value is 0', () => {
    expect(formatDelta(120, 0, 'zh')).toEqual({ direction: 'new', text: '' });
  });

  test('formatDelta returns flat when the values are equal', () => {
    expect(formatDelta(50, 50, 'zh').direction).toBe('flat');
  });

  test('formatDelta rounds to one decimal and picks the direction', () => {
    expect(formatDelta(112, 100, 'zh')).toEqual({ direction: 'up', text: '12.0%' });
    expect(formatDelta(88, 100, 'zh')).toEqual({ direction: 'down', text: '-12.0%' });
    expect(formatDelta(1, 3, 'zh').text).toBe('-66.7%');
  });

  test('formatDelta treats a rise as good and a fall as bad in both languages', () => {
    expect(formatDelta(200, 100, 'zh').direction).toBe('up');
    expect(formatDelta(200, 100, 'en').direction).toBe('up');
    expect(formatDelta(50, 100, 'en').direction).toBe('down');
  });

  test('formatDelta survives a zero CURRENT value without dividing by zero', () => {
    // prev is non-zero here, so this is the ordinary path — but a dashboard
    // that has just been switched to a range with no prior data hits it.
    expect(formatDelta(0, 40, 'zh')).toEqual({ direction: 'down', text: '-100.0%' });
  });
});

describe('analytics/datetime — dashboard additions', () => {
  // `formatOrgDate` has no language parameter: it reads the active dictionary,
  // like every other renderer here. Pin it rather than relying on the default.
  afterEach(() => setLang('en'));

  test('formatOrgDate renders in the org zone, not the browser zone', () => {
    setLang('zh');
    // 2026-04-15T23:30Z is already the 16th in Shanghai.
    expect(formatOrgDate('2026-04-15T23:30:00Z', 'Asia/Shanghai')).toBe('2026年4月16日');
    expect(formatOrgDate('2026-04-15T23:30:00Z', 'UTC')).toBe('2026年4月15日');
  });

  test('formatOrgDate follows the active language', () => {
    setLang('en');
    expect(formatOrgDate('2026-04-15T09:30:00Z', 'UTC')).toBe('Apr 15, 2026');
  });

  test('formatOrgDate falls back to the browser zone rather than throwing on an unusable zone', () => {
    // `orgs.timezone` is free text with no validation, so this is reachable.
    expect(() => formatOrgDate('2026-04-15T09:30:00Z', 'Not/AZone')).not.toThrow();
    expect(formatOrgDate('2026-04-15T09:30:00Z', 'Not/AZone')).not.toBe('—');
  });

  test('formatOrgDate returns an em dash for absent or unparseable input', () => {
    expect(formatOrgDate(null, 'UTC')).toBe('—');
    expect(formatOrgDate(undefined, 'UTC')).toBe('—');
    expect(formatOrgDate('not-a-date', 'UTC')).toBe('—');
  });

  test('formatOrgHour is the 24-hour clock used to pick the greeting', () => {
    expect(formatOrgHour('2026-04-15T09:30:00Z', 'UTC')).toBe('09:30');
    expect(formatOrgHour('2026-04-15T09:30:00Z', 'Asia/Shanghai')).toBe('17:30');
    // Midnight must render 00, not 24 — some ICU builds hand back 24 for h12.
    expect(formatOrgHour('2026-04-15T00:05:00Z', 'UTC')).toBe('00:05');
  });

  test('formatOrgHour returns null rather than an em dash, so callers can branch', () => {
    expect(formatOrgHour(null, 'UTC')).toBeNull();
    expect(formatOrgHour('nope', 'UTC')).toBeNull();
  });
});