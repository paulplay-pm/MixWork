import { describe, expect, test } from 'vitest';

import {
  MixWorkThinkingLevel,
  resolveOpenClawThinkingProfile,
} from '../../../openclaw-extensions/mixwork-model-compat/thinkingProfileMapping';

describe('mixwork model compatibility thinking profile precedence', () => {
  test('prefers a server thinking profile when a Kimi K3 runtime profile also exists', () => {
    expect(resolveOpenClawThinkingProfile({
      options: [
        { level: MixWorkThinkingLevel.Off, openclawLevel: 'off' },
        { level: MixWorkThinkingLevel.High, openclawLevel: 'high' },
        { level: MixWorkThinkingLevel.Max, openclawLevel: 'xhigh' },
      ],
      defaultLevel: MixWorkThinkingLevel.High,
    }, true)).toEqual({
      levels: [
        { id: 'off', label: 'off' },
        { id: 'high', label: 'high' },
        { id: 'xhigh', label: 'max' },
      ],
      defaultLevel: 'high',
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  test('uses the max-only Kimi K3 fallback when no server thinking profile exists', () => {
    expect(resolveOpenClawThinkingProfile(undefined, true)).toEqual({
      levels: [{ id: 'max', label: 'max' }],
      defaultLevel: 'max',
      preserveWhenCatalogReasoningFalse: true,
    });
  });
});