import { describe, expect, test } from 'vitest';

import { MODEL_TYPE_VALUES, ModelTypes } from '../../src/models/modelCatalog';
import { ProviderProtocol } from '../../src/vault/providerKeyVault';

describe('provider protocol + model type vocabulary', () => {
  test('MODEL_TYPE_VALUES 含 video-gen（视频生成目前只作为 chat 模型的 supports_video 能力，不是一个类型）', () => {
    expect(ModelTypes.VideoGen).toBe('video-gen');
    expect(MODEL_TYPE_VALUES).toContain('video-gen');
  });

  test('非 LLM adapter 也在模型类型里：asr / image-gen / video-gen', () => {
    for (const t of ['asr', 'image-gen', 'video-gen']) {
      expect(MODEL_TYPE_VALUES).toContain(t);
    }
  });

  test('ProviderProtocol 覆盖 LLM + realtime-asr + image-gen + video-gen', () => {
    expect(Object.values(ProviderProtocol).sort()).toEqual(
      ['anthropic', 'image-gen', 'openai', 'realtime-asr', 'video-gen'].sort(),
    );
  });
});
