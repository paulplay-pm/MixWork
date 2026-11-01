import { describe, expect, test } from 'vitest';

import {
  MixcworkThinkingLevel,
  resolveOpenClawThinkingProfile,
} from '../../../openclaw-extensions/mixcwork-model-compat/thinkingProfileMapping';

describe('mixcwork model compatibility thinking profile precedence', () => {
  test('prefers a server thinking profile when a Kimi K3 runtime profile also exists', () => {
    expect(resolveOpenClawThinkingProfile({
      options: [
        { level: MixcworkThinkingLevel.Off, openclawLevel: 'off' },
        { level: MixcworkThinkingLevel.High, openclawLevel: 'high' },
        { level: MixcworkThinkingLevel.Max, openclawLevel: 'xhigh' },
      ],
      defaultLevel: MixcworkThinkingLevel.High,
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