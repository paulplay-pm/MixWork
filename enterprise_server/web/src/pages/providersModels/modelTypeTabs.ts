import { ModelTypes, type ModelTypeValue } from '../../api/models';
import type { ProviderCardSectionView } from '../../api/providerCards';
import type { ProviderProtocol } from '../../api/providers';
import { PROVIDER_ENDPOINTS, type ProviderEndpointSet } from '../../data/providerCatalog';

/** The model types a vendor card can offer. One tab per model type. */
export const ModelTypeTabId = {
  Llm: 'llm',
  Asr: 'asr',
  Image: 'image',
  Video: 'video',
} as const;
export type ModelTypeTabId = (typeof ModelTypeTabId)[keyof typeof ModelTypeTabId];

export interface ModelTypeTabDef {
  id: ModelTypeTabId;
  /** The i18n key of the tab label. */
  labelKey: string;
  /** The protocol a NEW section of this tab is created with. */
  protocol: ProviderProtocol;
  /** The protocols this tab's section may speak. The LLM tab speaks openai OR
   * anthropic; the other three are fixed. */
  protocols: ProviderProtocol[];
  /** The model capabilities a model in this tab may carry. */
  modelTypes: ModelTypeValue[];
  /** Whether the section can fetch its model list from the vendor. Only the
   * chat protocols have a `/v1/models` endpoint. */
  canRefreshModels: boolean;
}

export const MODEL_TYPE_TABS: ModelTypeTabDef[] = [
  {
    id: ModelTypeTabId.Llm,
    labelKey: 'providersModels.card.capabilityLlm',
    protocol: 'openai',
    protocols: ['openai', 'anthropic'],
    modelTypes: [ModelTypes.Chat, ModelTypes.Vision, ModelTypes.Reasoning, ModelTypes.Embedding, ModelTypes.Rerank],
    canRefreshModels: true,
  },
  {
    id: ModelTypeTabId.Asr,
    labelKey: 'providersModels.card.capabilityAsr',
    protocol: 'realtime-asr',
    protocols: ['realtime-asr'],
    modelTypes: [ModelTypes.Asr],
    canRefreshModels: false,
  },
  {
    id: ModelTypeTabId.Image,
    labelKey: 'providersModels.card.capabilityImage',
    protocol: 'image-gen',
    protocols: ['image-gen'],
    modelTypes: [ModelTypes.ImageGen],
    canRefreshModels: false,
  },
  {
    id: ModelTypeTabId.Video,
    labelKey: 'providersModels.card.capabilityVideo',
    protocol: 'video-gen',
    protocols: ['video-gen'],
    modelTypes: [ModelTypes.VideoGen],
    canRefreshModels: false,
  },
];

/** The model-type tab that owns a protocol. */
export function tabForProtocol(protocol: ProviderProtocol): ModelTypeTabDef | undefined {
  return MODEL_TYPE_TABS.find((c) => c.protocols.includes(protocol));
}

/** The section of a card that belongs to a model type, if it has one. */
export function sectionForTab(
  sections: ProviderCardSectionView[],
  tabId: ModelTypeTabId
): ProviderCardSectionView | null {
  return sections.find((s) => tabForProtocol(s.protocol)?.id === tabId) ?? null;
}

/** The model types a section speaking this protocol may carry. */
export function modelTypesForProtocol(protocol: ProviderProtocol): ModelTypeValue[] {
  return tabForProtocol(protocol)?.modelTypes ?? [];
}

/**
 * The draft key an UNCONFIGURED tab's section uses. A configured tab is keyed
 * by its provider key id; a tab the admin has not filled in yet has no row,
 * so it needs a stable key of its own.
 */
export function draftKeyForTab(tabId: ModelTypeTabId): string {
  return `draft-${tabId}`;
}

/** The i18n key of a protocol's radio label. */
export const PROTOCOL_LABEL_KEY: Record<ProviderProtocol, string> = {
  openai: 'providersModels.protocol.openai',
  anthropic: 'providersModels.protocol.anthropic',
  'realtime-asr': 'providersModels.protocol.realtimeAsr',
  'image-gen': 'providersModels.protocol.imageGen',
  'video-gen': 'providersModels.protocol.videoGen',
};

/** Every protocol, in the order a radio renders them. */
export const PROTOCOL_ORDER: ProviderProtocol[] = [
  'openai',
  'anthropic',
  'realtime-asr',
  'image-gen',
  'video-gen',
];

/** Canonical Base URL per protocol. Choosing a protocol auto-fills this into
 * the Base URL field (it always overwrites the current value). */
export const PROTOCOL_DEFAULT_BASE_URL: Record<ProviderProtocol, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  // The non-chat adapters take the API ROOT — they append the version path
  // themselves, so a `/v1` suffix here would double up.
  'realtime-asr': 'https://api.minimaxi.com',
  'image-gen': 'https://api.minimaxi.com',
  'video-gen': 'https://api.minimaxi.com',
};

/** Which entry of a provider's endpoint set serves a protocol. */
const PROTOCOL_ENDPOINT_KEY: Record<ProviderProtocol, keyof ProviderEndpointSet> = {
  openai: 'openai',
  anthropic: 'anthropic',
  'realtime-asr': 'realtimeAsr',
  'image-gen': 'imageGen',
  'video-gen': 'videoGen',
};

/** The provider-specific Base URL for a protocol, falling back to the global
 * protocol default for custom / unknown slugs. */
export function defaultBaseUrlFor(slug: string, protocol: ProviderProtocol): string {
  const set = PROVIDER_ENDPOINTS[slug];
  return set?.[PROTOCOL_ENDPOINT_KEY[protocol]] ?? PROTOCOL_DEFAULT_BASE_URL[protocol];
}
