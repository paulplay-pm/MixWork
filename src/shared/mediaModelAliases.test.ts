import { describe, expect, it } from 'vitest';

import {
  bareMediaModelId,
  canonicalizeMediaModelId,
  GPT_IMAGE_2_MODEL_ID,
  mediaModelDisplayName,
} from './mediaModelAliases';

describe('mediaModelAliases', () => {
  it('canonicalizes legacy Canvas 20 model id', () => {
    expect(canonicalizeMediaModelId('canvas-20')).toBe(GPT_IMAGE_2_MODEL_ID);
    expect(canonicalizeMediaModelId(' gpt-image-2 ')).toBe(GPT_IMAGE_2_MODEL_ID);
  });

  it('uses gpt-image-2 as display name for Canvas 20 alias', () => {
    expect(mediaModelDisplayName('canvas-20', 'Canvas 20')).toBe(GPT_IMAGE_2_MODEL_ID);
    expect(mediaModelDisplayName('banana-2', 'Banana 2')).toBe('Banana 2');
  });

  // The server addresses media models as `<prefix>/<model>`, so two vendors can
  // both publish `image-01`. The alias table is about the MODEL, so it applies
  // to the bare part and the prefix rides along untouched.
  it('applies aliases to the bare part of a qualified id', () => {
    expect(canonicalizeMediaModelId('minimax/canvas-20')).toBe('minimax/gpt-image-2');
    expect(canonicalizeMediaModelId('canvas-20')).toBe('gpt-image-2');
    expect(canonicalizeMediaModelId('minimax/gpt-image-2')).toBe('minimax/gpt-image-2');
  });

  it('takes the bare name after the FIRST slash only', () => {
    expect(bareMediaModelId('minimax/image-01')).toBe('image-01');
    expect(bareMediaModelId('image-01')).toBe('image-01');
    // A model name may itself contain `/`; the prefix is still just the first
    // segment.
    expect(bareMediaModelId('minimax/hf/model')).toBe('hf/model');
    expect(bareMediaModelId('')).toBe('');
    expect(bareMediaModelId(null)).toBe('');
  });
});
