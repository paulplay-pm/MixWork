export const GPT_IMAGE_2_MODEL_ID = 'gpt-image-2';
export const CANVAS20_LEGACY_MODEL_ID = 'canvas-20';
export const HAPPYHORSE_1_1_MODEL_ID = 'HappyHorse-1.1';

const MEDIA_MODEL_ID_ALIASES: Record<string, string> = {
  [CANVAS20_LEGACY_MODEL_ID]: GPT_IMAGE_2_MODEL_ID,
  'happyhorse-1.1': HAPPYHORSE_1_1_MODEL_ID,
  [HAPPYHORSE_1_1_MODEL_ID]: HAPPYHORSE_1_1_MODEL_ID,
};

/** The prefix is the part before the FIRST `/`; a model name may contain `/`. */
export function bareMediaModelId(modelId: string | null | undefined): string {
  const normalized = typeof modelId === 'string' ? modelId.trim() : '';
  const slash = normalized.indexOf('/');
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

/**
 * Canonicalize a model id, prefix included.
 *
 * `canvas-20` → `gpt-image-2` and `minimax/canvas-20` → `minimax/gpt-image-2`:
 * the alias table is about the MODEL, so it applies to the bare part and the
 * prefix is carried through untouched.
 */
export function canonicalizeMediaModelId(modelId: string | null | undefined): string {
  const normalized = typeof modelId === 'string' ? modelId.trim() : '';
  const slash = normalized.indexOf('/');
  if (slash < 0) {
    return MEDIA_MODEL_ID_ALIASES[normalized] ?? normalized;
  }
  const prefix = normalized.slice(0, slash);
  const bare = normalized.slice(slash + 1);
  return `${prefix}/${MEDIA_MODEL_ID_ALIASES[bare] ?? bare}`;
}

export function mediaModelDisplayName(modelId: string | null | undefined, fallbackName?: string | null): string {
  const canonicalModelId = canonicalizeMediaModelId(modelId);
  if (canonicalModelId === GPT_IMAGE_2_MODEL_ID) {
    return GPT_IMAGE_2_MODEL_ID;
  }
  if (canonicalModelId === HAPPYHORSE_1_1_MODEL_ID) {
    return HAPPYHORSE_1_1_MODEL_ID;
  }
  const normalizedFallback = typeof fallbackName === 'string' ? fallbackName.trim() : '';
  return normalizedFallback || canonicalModelId;
}
