import { apiClient } from './client';

/**
 * The wire protocols a provider key can speak — mirrors the server's
 * `ProviderProtocol` (enterprise_server/src/vault/providerKeyVault.ts).
 *
 * `openai`/`anthropic` are the chat protocols the model proxy dispatches on.
 * `realtime-asr`/`image-gen`/`video-gen` are the non-chat adapters the ASR
 * and media backends resolve against. One row is one protocol, so an ASR or
 * image credential lives in the same table as a chat key.
 */
export const PROVIDER_PROTOCOLS = [
  'openai',
  'anthropic',
  'realtime-asr',
  'image-gen',
  'video-gen',
] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

/**
 * The protocols the chat model proxy dispatches on. The other three have no
 * `/v1/models` endpoint, so listing models and probing a connection do not
 * apply to them — the console hides those actions instead of showing a
 * guaranteed failure.
 */
export const CHAT_PROTOCOLS = ['openai', 'anthropic'] as const;
export type ChatProtocol = (typeof CHAT_PROTOCOLS)[number];

export function isChatProtocol(protocol: ProviderProtocol | string): protocol is ChatProtocol {
  return (CHAT_PROTOCOLS as readonly string[]).includes(protocol);
}

/** True for the two protocols whose providers the media backends serve. */
export function isMediaProtocol(protocol: ProviderProtocol | string): boolean {
  return protocol === 'image-gen' || protocol === 'video-gen';
}

export interface ProviderKeyView {
  id: string;
  provider: string;
  endpoint: string | null;
  label: string | null;
  enabled: boolean;
  region: 'china' | 'global' | null;
  default_base_url: string | null;
  website: string | null;
  description: string | null;
  api_key_masked: string | null;
  status: 'unknown' | 'connected' | 'failed';
  latency_ms: number | null;
  last_test_at: string | null;
  created_at: string;
  /** True for the 9 PRD built-in providers (migration 031). Built-ins cannot be deleted. */
  is_builtin: boolean;
  /** Wire protocol the endpoint speaks (migration 031). */
  protocol: ProviderProtocol;
  /** "Coding Plan" (beta) flag (migration 034): on → the Base URL uses the
   * provider's coding-specific endpoint. */
  coding_plan: boolean;
  /** Provider-specific settings (`config.model`, `config.limitSecondsToday`).
   * The media model list is NOT here: it lives in `model_catalog`, and the
   * server drops the retired `config.models` field on write. Never holds a
   * secret. */
  config?: Record<string, unknown> | null;
}

/** A media model the desktop's picker can select. Mirrors the server's
 * `MediaModelDescriptor` (enterprise_server/src/media/types.ts) minus the
 * parameter spec, which the desktop fills in itself. */
export interface MediaModelEntry {
  modelId: string;
  displayName: string;
}

export const providersApi = {
  list: (orgId: string) =>
    apiClient.get<ProviderKeyView[]>(`/admin/provider-keys?orgId=${encodeURIComponent(orgId)}`),
  add: (input: {
    orgId: string;
    provider: string;
    /** Optional for built-ins (no key needed); required in practice for custom providers. */
    apiKey?: string;
    label?: string;
    endpoint?: string;
    region?: 'china' | 'global';
    defaultBaseUrl?: string;
    website?: string;
    protocol?: ProviderProtocol;
    /** The vendor card this key is a capability section of. */
    cardId?: string;
    /** "Coding Plan" (beta) flag; on → the Base URL uses the coding endpoint. */
    codingPlan?: boolean;
    /** Provider-specific settings (the media model list). */
    config?: Record<string, unknown>;
  }) => apiClient.post<{ id: string }>('/admin/provider-keys', input),
  setEnabled: (id: string, enabled: boolean) =>
    apiClient.post<{ ok: true }>(
      `/admin/provider-keys/${id}/${enabled ? 'enable' : 'disable'}`
    ),
  refreshModels: (id: string) =>
    apiClient.post<{
      added: number;
      unchanged: number;
      upstreamCount?: number;
      error?:
        | 'invalid_api_key'
        | 'upstream_error'
        | 'upstream_timeout'
        | 'empty_endpoint'
        | 'not_a_chat_provider';
      detail?: string;
    }>(`/admin/provider-keys/${id}/refresh-models`),
  patch: (
    id: string,
    body: {
      description?: string | null;
      baseUrl?: string | null;
      label?: string | null;
      enabled?: boolean;
      protocol?: ProviderProtocol;
      /** "Coding Plan" (beta) flag; on → the Base URL uses the coding endpoint. */
      codingPlan?: boolean;
      /** Provider-specific settings; merged into the stored JSONB by the server. */
      config?: Record<string, unknown>;
      /** Replace the API key; omit to keep the current one. */
      apiKey?: string;
    }
  ) => apiClient.patch<{ ok: true }>(`/admin/provider-keys/${id}`, body),
  remove: (id: string) =>
    apiClient.delete<{ ok: true; deletedModels: number }>(
      `/admin/provider-keys/${id}`
    ),
  test: (id: string) =>
    apiClient.post<{
      status: 'connected' | 'failed' | 'unknown';
      latencyMs: number;
      lastTestAt: string;
      error?: 'not_a_chat_provider' | 'no_endpoint';
    }>(`/admin/provider-keys/${id}/test`),
};
