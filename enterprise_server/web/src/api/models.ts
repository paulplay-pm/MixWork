import { apiClient } from './client';

/** Model type labels, matching the backend `ModelType` (migration 017).
 * Closed set shown in the model table's "类型" column. */
export const ModelType = {
  Chat: 'chat',
  Reasoning: 'reasoning',
  Vision: 'vision',
  Embedding: 'embedding',
  Image: 'image',
  Audio: 'audio',
} as const;
export type ModelType = (typeof ModelType)[keyof typeof ModelType];

/** Multi-capability type set (PRD V1.0 §4.3.1, migration 032 `types TEXT[]`).
 * A model can carry several of these; mirrors the backend `ModelTypes`. */
export const ModelTypes = {
  Chat: 'chat',
  Vision: 'vision',
  Reasoning: 'reasoning',
  ImageGen: 'image-gen',
  Embedding: 'embedding',
  Rerank: 'rerank',
  Asr: 'asr',
  Tts: 'tts',
  VideoGen: 'video-gen',
} as const;
export type ModelTypeValue = (typeof ModelTypes)[keyof typeof ModelTypes];
export const MODEL_TYPE_VALUES: ModelTypeValue[] = Object.values(ModelTypes);

export interface ModelView {
  id: string;
  provider: string;
  /** The provider KEY this model belongs to. Two keys can share a `provider`
   * slug (a built-in `deepseek` key and a custom `deepseek` key), so this is
   * the only field that distinguishes their same-named models. Served by the
   * admin list (`GET /admin/models`); the admin console groups models by this
   * (falling back to `provider` when absent). */
  provider_key_id?: string;
  model: string;
  display_name: string | null;
  type: ModelType;
  /** Multi-capability type set (migration 032). `type` above is deprecated but
   * still served by the backend for backward compatibility. */
  types: ModelTypeValue[];
  quota_per_user_per_day: number | null;
  enabled: boolean;
  disabled_by_admin: boolean;
  supports_image: boolean;
  supports_video: boolean;
  supports_thinking: boolean;
  context_window: number | null;
  max_tokens: number | null;
  temperature: number | null;
  top_p: number | null;
  max_output_tokens: number | null;
  /** Free-form capability parameters (JSONB on the catalog row). Carried by
   * media / speech models; the agent is told about them. */
  parameter_spec?: Record<string, unknown> | null;
}

/** A model can be routed to only when both switches say so: the model's own
 * `enabled`, and the admin's `disabled_by_admin` override. Every place the
 * console counts, lists, or offers models uses this one test. */
export function isModelEnabled(
  model: Pick<ModelView, 'enabled' | 'disabled_by_admin'>
): boolean {
  return model.enabled && !model.disabled_by_admin;
}

/** The models in a list that can actually be routed to. */
export function countEnabledModels(models: readonly ModelView[]): number {
  return models.filter(isModelEnabled).length;
}

/** The per-type default model pointers: `[{ type, modelId }]`. The console
 * renders the "default" badge on the model's type chip, so it needs to know
 * which (model, type) pairs are defaults. */
export const modelTypeDefaultsApi = {
  list: (orgId: string) =>
    apiClient.get<Array<{ type: string; modelId: string }>>(
      `/admin/model-type-defaults?orgId=${encodeURIComponent(orgId)}`
    ),
};

export const modelsApi = {
  list: (orgId: string) =>
    apiClient.get<ModelView[]>(`/admin/models?orgId=${encodeURIComponent(orgId)}`),
  add: (input: {
    orgId: string;
    providerKeyId: string;
    provider: string;
    model: string;
    displayName?: string;
    type?: ModelType;
    types?: ModelTypeValue[];
    quotaPerDay?: number | null;
    /** Free-form capability parameters; stored as JSONB. */
    parameterSpec?: Record<string, unknown>;
    capabilities?: {
      supportsImage?: boolean;
      supportsVideo?: boolean;
      supportsThinking?: boolean;
      contextWindow?: number | null;
      maxTokens?: number | null;
      temperature?: number | null;
      topP?: number | null;
      maxOutputTokens?: number | null;
    };
  }) => apiClient.post<{ id: string }>('/admin/models', input),
  setQuota: (id: string, quotaPerDay: number | null) =>
    apiClient.post<{ ok: true }>(`/admin/models/${id}/quota`, { quotaPerDay }),
  disable: (id: string) => apiClient.post<{ ok: true }>(`/admin/models/${id}/disable`),
  enable: (id: string) => apiClient.post<{ ok: true }>(`/admin/models/${id}/enable`),
  patch: (
    id: string,
    body: {
      displayName?: string;
      type?: ModelType;
      types?: ModelTypeValue[];
      enabled?: boolean;
      /** Free-form capability parameters; stored as JSONB. */
      parameterSpec?: Record<string, unknown>;
      /** Move this type's default-model pointer onto this model (or clear it
       * with `isDefault: false`). Only valid when `types` includes `type`. */
      defaultForType?: { type: ModelTypeValue; isDefault: boolean };
      capabilities?: {
        supportsImage?: boolean;
        supportsVideo?: boolean;
        supportsThinking?: boolean;
        contextWindow?: number | null;
        maxTokens?: number | null;
        temperature?: number | null;
        topP?: number | null;
        maxOutputTokens?: number | null;
      };
    },
    orgId: string
  ) =>
    apiClient.patch<{ ok: true }>(
      `/admin/models/${id}?orgId=${encodeURIComponent(orgId)}`,
      body
    ),
  remove: (id: string, orgId: string) =>
    apiClient.delete<{ ok: true }>(
      `/admin/models/${id}?orgId=${encodeURIComponent(orgId)}`
    ),
};