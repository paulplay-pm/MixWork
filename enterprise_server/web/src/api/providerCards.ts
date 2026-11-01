import { apiClient } from './client';
import type { ProviderProtocol } from './providers';

/**
 * One capability section of a vendor card — a single `provider_keys` row
 * (one credential, one wire protocol). Mirrors the server's
 * `ProviderCardSection` (enterprise_server/src/models/providerCards.ts).
 * The server sends camelCase here; do NOT "fix" it to snake_case — the rest
 * of the console's provider API is snake_case because the server's
 * `provider_keys` view is, and the two shapes genuinely differ.
 */
export interface ProviderCardSectionView {
  providerKeyId: string;
  protocol: ProviderProtocol;
  label: string | null;
  endpoint: string | null;
  enabled: boolean;
  /** A built-in credential row: it cannot be deleted, only disabled. */
  isBuiltin: boolean;
  codingPlan: boolean;
  apiKeyMasked: string | null;
  /** How many models this section's model table shows. */
  modelCount: number;
}

/** One vendor card: a vendor plus its capability sections. */
export interface ProviderCardView {
  id: string;
  /** The vendor slug ('minimax'). */
  provider: string;
  /** The card's display name; null → the console falls back to the slug. */
  label: string | null;
  createdAt: string;
  /** True when any section of the card is a built-in credential row. */
  isBuiltin: boolean;
  /** The card's master switch: on when at least one section is enabled. */
  enabled: boolean;
  sections: ProviderCardSectionView[];
}

export const providerCardsApi = {
  list: (orgId: string) =>
    apiClient.get<ProviderCardView[]>(
      `/admin/provider-cards?orgId=${encodeURIComponent(orgId)}`
    ),
  create: (input: { orgId: string; provider: string; label?: string }) =>
    apiClient.post<{ id: string }>('/admin/provider-cards', input),
  patch: (id: string, body: { label?: string | null; enabled?: boolean }) =>
    apiClient.patch<{ ok: true }>(`/admin/provider-cards/${id}`, body),
  remove: (id: string) =>
    apiClient.delete<{ ok: true; deletedKeys: number; deletedModels: number }>(
      `/admin/provider-cards/${id}`
    ),
};
