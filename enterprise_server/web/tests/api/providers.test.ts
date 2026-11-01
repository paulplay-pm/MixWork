import { describe, expect, test } from 'vitest';

import {
  CHAT_PROTOCOLS,
  isChatProtocol,
  PROVIDER_PROTOCOLS,
  type ProviderProtocol,
} from '../../src/api/providers';

/**
 * The provider protocol vocabulary the console shares with the server
 * (`enterprise_server/src/vault/providerKeyVault.ts`). The chat protocols are
 * the ones the model proxy dispatches on; the other three are the non-chat
 * adapters the ASR and media backends resolve against.
 */
describe('api/providers protocols', () => {
  test('exposes every protocol the server accepts', () => {
    expect([...PROVIDER_PROTOCOLS]).toEqual([
      'openai',
      'anthropic',
      'realtime-asr',
      'image-gen',
      'video-gen',
    ]);
  });

  test('the chat protocols are the two model-proxy ones', () => {
    expect([...CHAT_PROTOCOLS]).toEqual(['openai', 'anthropic']);
  });

  test('isChatProtocol is true only for chat protocols', () => {
    expect(isChatProtocol('openai')).toBe(true);
    expect(isChatProtocol('anthropic')).toBe(true);
    expect(isChatProtocol('realtime-asr')).toBe(false);
    expect(isChatProtocol('image-gen')).toBe(false);
    expect(isChatProtocol('video-gen')).toBe(false);
  });

  test('a provider row can carry a non-chat protocol', () => {
    // The type is the point: a protocol union that only had the chat pair
    // would make an ASR row untyped away, which is how the UI ended up with
    // no radio checked for it.
    const asr: ProviderProtocol = 'realtime-asr';
    expect(asr).toBe('realtime-asr');
  });
});
