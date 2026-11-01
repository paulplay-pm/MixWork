import { describe, expect, test } from 'vitest';

import {
  MediaGenerationTool,
  MediaSelectionMode,
  type MediaSelectionState,
} from '../mediaGenerationPolicy';
import { resolveEffectiveMediaSelection } from './mediaSelectionFallback';

const boundImageSelection: MediaSelectionState = {
  mode: MediaSelectionMode.Image,
  imageModelId: 'image-01',
};

const boundVideoSelection: MediaSelectionState = {
  mode: MediaSelectionMode.Video,
  videoModelId: 'HappyHorse-1.1-t2v',
};

describe('resolveEffectiveMediaSelection', () => {
  test('a bound selection always wins over the tool-requested model', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: boundImageSelection,
      explicitModel: 'image-02',
      availableModelIds: ['image-01', 'image-02'],
    });
    expect(result.source).toBe('bound');
    expect(result.selection).toEqual(boundImageSelection);
    expect(result.unavailableModel).toBeUndefined();
  });

  test('a bound video selection also wins over the tool-requested model', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Video,
      boundSelection: boundVideoSelection,
      explicitModel: 'HappyHorse-1.1-i2v',
      availableModelIds: ['HappyHorse-1.1-t2v', 'HappyHorse-1.1-i2v'],
    });
    expect(result.source).toBe('bound');
    expect(result.selection).toEqual(boundVideoSelection);
  });

  test('a bound "none" selection falls back to the tool-requested model when it is available', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: { mode: MediaSelectionMode.None },
      explicitModel: 'image-01',
      availableModelIds: ['image-01'],
    });
    expect(result.source).toBe('tool');
    expect(result.selection).toEqual({
      mode: MediaSelectionMode.Image,
      modelId: 'image-01',
      imageModelId: 'image-01',
    });
  });

  test('no bound selection + an available image model resolves an image selection', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: undefined,
      explicitModel: 'image-01',
      availableModelIds: ['image-01'],
    });
    expect(result.selection?.mode).toBe(MediaSelectionMode.Image);
    expect(result.selection?.imageModelId).toBe('image-01');
    expect(result.selection?.modelId).toBe('image-01');
  });

  test('no bound selection + an available video model resolves a video selection', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Video,
      boundSelection: undefined,
      explicitModel: 'HappyHorse-1.1-t2v',
      availableModelIds: ['HappyHorse-1.1-t2v', 'HappyHorse-1.1-i2v'],
    });
    expect(result.selection?.mode).toBe(MediaSelectionMode.Video);
    expect(result.selection?.videoModelId).toBe('HappyHorse-1.1-t2v');
    expect(result.selection?.modelId).toBe('HappyHorse-1.1-t2v');
  });

  test('a tool-requested model that is not available fails closed', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: undefined,
      explicitModel: 'image-02',
      availableModelIds: ['image-01'],
    });
    expect(result.source).toBe('none');
    expect(result.selection).toBeUndefined();
    expect(result.unavailableModel).toBe('image-02');
  });

  test('a tool-requested model with no configured models fails closed', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: undefined,
      explicitModel: 'image-01',
      availableModelIds: [],
    });
    expect(result.source).toBe('none');
    expect(result.selection).toBeUndefined();
    expect(result.noModelsConfigured).toBe(true);
  });

  test('no bound selection and no explicit model fails closed with no reason detail', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: undefined,
      explicitModel: '',
      availableModelIds: ['image-01'],
    });
    expect(result.source).toBe('none');
    expect(result.selection).toBeUndefined();
    expect(result.unavailableModel).toBeUndefined();
    expect(result.noModelsConfigured).toBeUndefined();
  });

  test('a whitespace-only explicit model is treated as absent', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: undefined,
      explicitModel: '   ',
      availableModelIds: ['image-01'],
    });
    expect(result.source).toBe('none');
    expect(result.selection).toBeUndefined();
  });

  test('a server default model is used when the tool names no model', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: undefined,
      explicitModel: '',
      availableModelIds: ['minimax/image-01'],
      defaultModelId: 'minimax/image-01',
    });
    expect(result.source).toBe('default');
    expect(result.selection?.modelId).toBe('minimax/image-01');
    expect(result.selection?.imageModelId).toBe('minimax/image-01');
  });

  test('an explicit model wins over the server default', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: undefined,
      explicitModel: 'minimax/image-02',
      availableModelIds: ['minimax/image-01', 'minimax/image-02'],
      defaultModelId: 'minimax/image-01',
    });
    expect(result.source).toBe('tool');
    expect(result.selection?.modelId).toBe('minimax/image-02');
  });

  test('a default model the account does not have is not a default', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: undefined,
      explicitModel: '',
      availableModelIds: ['minimax/image-01'],
      defaultModelId: 'other/image-99',
    });
    expect(result.source).toBe('none');
    expect(result.selection).toBeUndefined();
  });

  test('a bare explicit model matches a qualified available id', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: undefined,
      explicitModel: 'image-01',
      availableModelIds: ['minimax/image-01'],
    });
    expect(result.source).toBe('tool');
    expect(result.selection?.modelId).toBe('image-01');
  });

  test('an explicit model that is not available still fails closed (no default fallback)', () => {
    const result = resolveEffectiveMediaSelection({
      tool: MediaGenerationTool.Image,
      boundSelection: undefined,
      explicitModel: 'minimax/image-99',
      availableModelIds: ['minimax/image-01'],
      defaultModelId: 'minimax/image-01',
    });
    expect(result.source).toBe('none');
    expect(result.unavailableModel).toBe('minimax/image-99');
    expect(result.selection).toBeUndefined();
  });
});
