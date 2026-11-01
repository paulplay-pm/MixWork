import { describe, expect, test } from 'vitest';

import {
  defaultBaseUrlFor,
  draftKeyForTab,
  MODEL_TYPE_TABS,
  modelTypesForProtocol,
  ModelTypeTabId,
  tabForProtocol,
} from '../../../src/pages/providersModels/modelTypeTabs';

describe('pages/providersModels/modelTypeTabs', () => {
  test('every protocol belongs to exactly one model-type tab', () => {
    expect(tabForProtocol('openai')?.id).toBe(ModelTypeTabId.Llm);
    expect(tabForProtocol('anthropic')?.id).toBe(ModelTypeTabId.Llm);
    expect(tabForProtocol('realtime-asr')?.id).toBe(ModelTypeTabId.Asr);
    expect(tabForProtocol('image-gen')?.id).toBe(ModelTypeTabId.Image);
    expect(tabForProtocol('video-gen')?.id).toBe(ModelTypeTabId.Video);
  });

  test('the LLM tab offers the openai and anthropic protocols', () => {
    const llm = MODEL_TYPE_TABS.find((c) => c.id === ModelTypeTabId.Llm)!;
    expect(llm.protocols).toEqual(['openai', 'anthropic']);
    expect(llm.canRefreshModels).toBe(true);
  });

  test('the media and speech tabs cannot fetch models', () => {
    for (const id of [ModelTypeTabId.Asr, ModelTypeTabId.Image, ModelTypeTabId.Video]) {
      const c = MODEL_TYPE_TABS.find((x) => x.id === id)!;
      expect(c.canRefreshModels).toBe(false);
      expect(c.protocols).toHaveLength(1);
    }
  });

  test('each tab allows exactly the model capabilities of its protocol', () => {
    expect(modelTypesForProtocol('openai')).toEqual(['chat', 'vision', 'reasoning', 'embedding', 'rerank']);
    expect(modelTypesForProtocol('realtime-asr')).toEqual(['asr']);
    expect(modelTypesForProtocol('image-gen')).toEqual(['image-gen']);
    expect(modelTypesForProtocol('video-gen')).toEqual(['video-gen']);
  });

  test('draftKeyForTab keys an unconfigured tab by its tab id', () => {
    expect(draftKeyForTab(ModelTypeTabId.Image)).toBe('draft-image');
  });

  test('a non-chat protocol gets the API root, not a /v1 URL', () => {
    expect(defaultBaseUrlFor('minimax', 'image-gen')).toBe('https://api.minimaxi.com');
    expect(defaultBaseUrlFor('minimax', 'realtime-asr')).toBe('https://api.minimaxi.com');
    expect(defaultBaseUrlFor('openai', 'openai')).toBe('https://api.openai.com/v1');
    // An unknown slug falls back to the global protocol default.
    expect(defaultBaseUrlFor('vllm-custom', 'anthropic')).toBe('https://api.anthropic.com');
  });
});
