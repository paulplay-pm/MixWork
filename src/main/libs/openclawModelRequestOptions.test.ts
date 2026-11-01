import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';
import { describe, expect, test } from 'vitest';

import {
  createMixcworkRequestOptionsWrapper,
  MIXCWORK_REQUEST_OPTIONS_FIELD,
  resolveMixcworkRequestThinkingLevel,
} from '../../../openclaw-extensions/mixcwork-model-compat/requestOptions';
import { MIXCWORK_REQUEST_OPTIONS_VERSION } from '../../../openclaw-extensions/mixcwork-model-compat/requestOptionsProtocol';
import type { MixcworkThinkingProfile } from '../../../openclaw-extensions/mixcwork-model-compat/thinkingProfileMapping';

const profile: MixcworkThinkingProfile = {
  options: [
    { level: 'off', openclawLevel: 'off' },
    { level: 'high', openclawLevel: 'high' },
    { level: 'max', openclawLevel: 'xhigh' },
  ],
  defaultLevel: 'high',
  requestOptionsVersion: 1,
};

describe('MixCWork request options', () => {
  test('uses an allowed selected level and falls back to the profile default', () => {
    expect(resolveMixcworkRequestThinkingLevel(profile, 'off')).toBe('off');
    expect(resolveMixcworkRequestThinkingLevel(profile, 'xhigh')).toBe('max');
    expect(resolveMixcworkRequestThinkingLevel(profile, 'low')).toBe('high');
    expect(resolveMixcworkRequestThinkingLevel(profile, undefined)).toBe('high');
  });

  test('adds the final semantic thinking intent after the caller payload hook', async () => {
    let forwardedOptions: Parameters<StreamFn>[2] | undefined;
    const baseStreamFn: StreamFn = ((_model, _context, options) => {
      forwardedOptions = options;
      return {} as ReturnType<StreamFn>;
    }) as StreamFn;
    const wrapped = createMixcworkRequestOptionsWrapper(baseStreamFn, 'off');

    await wrapped({} as never, {} as never, {
      onPayload: () => ({
        model: 'deepseek-v4-flash-MixcworkInner',
        [MIXCWORK_REQUEST_OPTIONS_FIELD]: {
          version: 999,
          thinking: { level: 'max' },
        },
      }),
    });

    const payload = await forwardedOptions?.onPayload?.({}, {} as never);
    const expectedOptions = {
      version: MIXCWORK_REQUEST_OPTIONS_VERSION,
      thinking: { level: 'off' },
    };
    expect(payload).toEqual({
      model: 'deepseek-v4-flash-MixcworkInner',
      [MIXCWORK_REQUEST_OPTIONS_FIELD]: expectedOptions,
    });
  });
});
