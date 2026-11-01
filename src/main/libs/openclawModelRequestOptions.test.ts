import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';
import { describe, expect, test } from 'vitest';

import {
  createMixWorkRequestOptionsWrapper,
  MIXWORK_REQUEST_OPTIONS_FIELD,
  resolveMixWorkRequestThinkingLevel,
} from '../../../openclaw-extensions/mixwork-model-compat/requestOptions';
import { MIXWORK_REQUEST_OPTIONS_VERSION } from '../../../openclaw-extensions/mixwork-model-compat/requestOptionsProtocol';
import type { MixWorkThinkingProfile } from '../../../openclaw-extensions/mixwork-model-compat/thinkingProfileMapping';

const profile: MixWorkThinkingProfile = {
  options: [
    { level: 'off', openclawLevel: 'off' },
    { level: 'high', openclawLevel: 'high' },
    { level: 'max', openclawLevel: 'xhigh' },
  ],
  defaultLevel: 'high',
  requestOptionsVersion: 1,
};

describe('MixWork request options', () => {
  test('uses an allowed selected level and falls back to the profile default', () => {
    expect(resolveMixWorkRequestThinkingLevel(profile, 'off')).toBe('off');
    expect(resolveMixWorkRequestThinkingLevel(profile, 'xhigh')).toBe('max');
    expect(resolveMixWorkRequestThinkingLevel(profile, 'low')).toBe('high');
    expect(resolveMixWorkRequestThinkingLevel(profile, undefined)).toBe('high');
  });

  test('adds the final semantic thinking intent after the caller payload hook', async () => {
    let forwardedOptions: Parameters<StreamFn>[2] | undefined;
    const baseStreamFn: StreamFn = ((_model, _context, options) => {
      forwardedOptions = options;
      return {} as ReturnType<StreamFn>;
    }) as StreamFn;
    const wrapped = createMixWorkRequestOptionsWrapper(baseStreamFn, 'off');

    await wrapped({} as never, {} as never, {
      onPayload: () => ({
        model: 'deepseek-v4-flash-MixWorkInner',
        [MIXWORK_REQUEST_OPTIONS_FIELD]: {
          version: 999,
          thinking: { level: 'max' },
        },
      }),
    });

    const payload = await forwardedOptions?.onPayload?.({}, {} as never);
    const expectedOptions = {
      version: MIXWORK_REQUEST_OPTIONS_VERSION,
      thinking: { level: 'off' },
    };
    expect(payload).toEqual({
      model: 'deepseek-v4-flash-MixWorkInner',
      [MIXWORK_REQUEST_OPTIONS_FIELD]: expectedOptions,
    });
  });
});
