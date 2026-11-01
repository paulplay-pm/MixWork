import { describe, expect, test } from 'vitest';

import {
  createMediaModelAvailabilityCache,
  mediaModelEntriesFromListResponse,
} from './mediaModelAvailability';

describe('createMediaModelAvailabilityCache', () => {
  test('fetches once and serves the cached entries within the TTL', async () => {
    let calls = 0;
    const cache = createMediaModelAvailabilityCache({
      now: () => 1_000,
      ttlMs: 60_000,
      fetchModels: async () => {
        calls += 1;
        return [{ modelId: 'image-01' }];
      },
    });

    const first = await cache.get('image', 'owner-a');
    const second = await cache.get('image', 'owner-a');

    expect(first).toEqual([{ modelId: 'image-01' }]);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  test('scopes the cache by account owner and media kind', async () => {
    const calls: string[] = [];
    const cache = createMediaModelAvailabilityCache({
      now: () => 1_000,
      ttlMs: 60_000,
      fetchModels: async (kind) => {
        calls.push(kind);
        return [{ modelId: `${kind}-01` }];
      },
    });

    await cache.get('image', 'owner-a');
    await cache.get('video', 'owner-a');
    await cache.get('image', 'owner-b');

    expect(calls).toEqual(['image', 'video', 'image']);
  });

  test('refetches after the TTL expires', async () => {
    let now = 1_000;
    let calls = 0;
    const cache = createMediaModelAvailabilityCache({
      now: () => now,
      ttlMs: 60_000,
      fetchModels: async () => {
        calls += 1;
        return [{ modelId: 'image-01' }];
      },
    });

    await cache.get('image', 'owner-a');
    now = 1_000 + 60_001;
    await cache.get('image', 'owner-a');

    expect(calls).toBe(2);
  });

  test('coalesces concurrent fetches for the same key', async () => {
    let calls = 0;
    const cache = createMediaModelAvailabilityCache({
      now: () => 1_000,
      ttlMs: 60_000,
      fetchModels: async () => {
        calls += 1;
        return [{ modelId: 'image-01' }];
      },
    });

    const [a, b] = await Promise.all([
      cache.get('image', 'owner-a'),
      cache.get('image', 'owner-a'),
    ]);

    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  test('clear drops both cached entries and in-flight requests', async () => {
    let calls = 0;
    const cache = createMediaModelAvailabilityCache({
      now: () => 1_000,
      ttlMs: 60_000,
      fetchModels: async () => {
        calls += 1;
        return [{ modelId: 'image-01' }];
      },
    });

    await cache.get('image', 'owner-a');
    cache.clear();
    await cache.get('image', 'owner-a');

    expect(calls).toBe(2);
  });

  test('carries the server default model on every entry', async () => {
    const cache = createMediaModelAvailabilityCache({
      now: () => 1_000,
      fetchModels: async () => [
        { modelId: 'minimax/image-01', defaultModel: 'minimax/image-01' },
        { modelId: 'minimax/image-02', defaultModel: 'minimax/image-01' },
      ],
    });
    const entries = await cache.get('image', 'owner-a');
    expect(entries[0].defaultModel).toBe('minimax/image-01');
  });

  describe('mediaModelEntriesFromListResponse', () => {
    test('reads the envelope default model onto every entry', () => {
      const entries = mediaModelEntriesFromListResponse({
        code: 0,
        data: [
          { modelId: 'minimax/image-01', displayName: 'Image 01' },
          { modelId: 'minimax/image-02' },
        ],
        defaultModel: 'minimax/image-01',
      });
      expect(entries).toEqual([
        { modelId: 'minimax/image-01', displayName: 'Image 01', defaultModel: 'minimax/image-01' },
        { modelId: 'minimax/image-02', displayName: 'minimax/image-02', defaultModel: 'minimax/image-01' },
      ]);
    });

    test('leaves defaultModel off when the server has none', () => {
      const entries = mediaModelEntriesFromListResponse({
        code: 0,
        data: [{ modelId: 'minimax/image-01' }],
        defaultModel: null,
      });
      expect(entries[0].defaultModel).toBeUndefined();
    });

    test('a non-zero code yields no entries', () => {
      expect(mediaModelEntriesFromListResponse({ code: 41400, data: [{ modelId: 'x' }] })).toEqual([]);
    });

    test('canonicalizes the ids (aliases apply to the bare part)', () => {
      const entries = mediaModelEntriesFromListResponse({
        code: 0,
        data: [{ modelId: 'minimax/canvas-20' }],
        defaultModel: 'minimax/canvas-20',
      });
      expect(entries[0].modelId).toBe('minimax/gpt-image-2');
      expect(entries[0].defaultModel).toBe('minimax/gpt-image-2');
    });
  });
});
