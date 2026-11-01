import { describe, expect, test } from 'vitest';

import { i18nDicts } from '../../src/i18n';

describe('i18n', () => {
  test('every English key has a Chinese translation', () => {
    const zhKeys = new Set(Object.keys(i18nDicts.zh));
    const missing = Object.keys(i18nDicts.en).filter((key) => !zhKeys.has(key));
    expect(missing).toEqual([]);
  });

  test('every Chinese key has an English translation', () => {
    const enKeys = new Set(Object.keys(i18nDicts.en));
    const missing = Object.keys(i18nDicts.zh).filter((key) => !enKeys.has(key));
    expect(missing).toEqual([]);
  });
});
