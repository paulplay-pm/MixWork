import { describe, expect, test } from 'vitest';

import {
  providerCardsApi,
  type ProviderCardSectionView,
  type ProviderCardView,
} from '../../src/api/providerCards';

describe('api/providerCards', () => {
  // A type-level contract: the console reads camelCase section fields from
  // the card view (the rest of the provider API is snake_case, so this is the
  // one place a "helpful" rename would silently break the card).
  test('the card view carries the sections the server sends', () => {
    const section: ProviderCardSectionView = {
      providerKeyId: 'k1',
      protocol: 'openai',
      label: null,
      endpoint: 'https://api.openai.com/v1',
      enabled: true,
      isBuiltin: false,
      codingPlan: false,
      apiKeyMasked: 'sk-…abcd',
      modelCount: 3,
    };
    const card: ProviderCardView = {
      id: 'c1',
      provider: 'openai',
      label: null,
      createdAt: '2026-10-25T00:00:00.000Z',
      isBuiltin: false,
      enabled: true,
      sections: [section],
    };
    expect(card.sections[0].modelCount).toBe(3);
    expect(card.sections[0].protocol).toBe('openai');
  });

  test('exposes the four admin operations', () => {
    expect(typeof providerCardsApi.list).toBe('function');
    expect(typeof providerCardsApi.create).toBe('function');
    expect(typeof providerCardsApi.patch).toBe('function');
    expect(typeof providerCardsApi.remove).toBe('function');
  });
});
