import { ProviderName } from '@shared/providers';

import type { Model } from '../store/slices/modelSlice';

/** Minimal shape required by `mapEnterpriseModelsToModels`. */
export interface EnterpriseModelViewLike {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  capabilities?: {
    supports_image?: boolean;
    supports_video?: boolean;
    supports_thinking?: boolean;
    context_window?: number | null;
    max_tokens?: number | null;
  } | null;
}

/**
 * Adapter from the enterprise catalog (`EnterpriseModelView`) shape that
 * `window.electron.enterpriseModels.list()` returns, into the renderer's
 * `Model` shape that ModelSelector consumes.
 *
 * The renderer MUST NOT see the `_k`/apiKey field — the IPC layer strips it
 * before the response reaches this code.
 */
export function mapEnterpriseModelsToModels(
  models: EnterpriseModelViewLike[],
): Model[] {
  return models.map((model) => {
    const caps = model.capabilities;
    const supportsThinking = caps?.supports_thinking === true;
    return {
      id: model.id,
      name: model.displayName ?? model.model ?? model.id,
      provider: model.provider,
      providerKey: ProviderName.MixWorkServer,
      isServerModel: true,
      supportsImage: caps?.supports_image ?? false,
      supportsVideo: caps?.supports_video ?? false,
      supportsThinking,
      contextWindow: caps?.context_window ?? undefined,
      maxTokens: caps?.max_tokens ?? undefined,
      accessible: true,
    };
  });
}
