import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';

import {
  MIXCWORK_REQUEST_OPTIONS_FIELD,
  MIXCWORK_REQUEST_OPTIONS_VERSION,
} from './requestOptionsProtocol';
import type {
  MixcworkThinkingLevel,
  MixcworkThinkingProfile,
} from './thinkingProfileMapping';

export {
  MIXCWORK_REQUEST_OPTIONS_FIELD,
  MIXCWORK_REQUEST_OPTIONS_VERSION,
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const loadDefaultStreamFn = async (): Promise<StreamFn> => {
  const { streamSimple } = await import('openclaw/plugin-sdk/llm');
  return streamSimple as StreamFn;
};

export const resolveMixcworkRequestThinkingLevel = (
  profile: MixcworkThinkingProfile,
  requestedLevel: string | undefined,
): MixcworkThinkingLevel => (
  profile.options.find(option => option.openclawLevel === requestedLevel)?.level
    ?? profile.defaultLevel
);

const applyRequestOptions = (
  payload: unknown,
  thinkingLevel: MixcworkThinkingLevel,
): unknown => {
  if (!isRecord(payload)) return payload;
  // Single-write emit under the mixcwork_options wire field. After Phase 3,
  // the legacy mixcwork_options field is no longer written or accepted.
  const options = {
    version: MIXCWORK_REQUEST_OPTIONS_VERSION,
    thinking: { level: thinkingLevel },
  };
  payload[MIXCWORK_REQUEST_OPTIONS_FIELD] = options;
  return payload;
};

export const createMixcworkRequestOptionsWrapper = (
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: MixcworkThinkingLevel,
): StreamFn => {
  return async (model, context, options) => {
    const underlying = baseStreamFn ?? (await loadDefaultStreamFn());
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload, payloadModel) => {
        const result = originalOnPayload?.(payload, payloadModel);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return Promise.resolve(result).then(resolved => (
            applyRequestOptions(resolved ?? payload, thinkingLevel)
          ));
        }
        return applyRequestOptions(result ?? payload, thinkingLevel);
      },
    });
  };
};
