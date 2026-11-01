import { canonicalizeMediaModelId, mediaModelDisplayName } from '../../shared/mediaModelAliases';

export interface MediaModelAvailabilityEntry {
  modelId: string;
  displayName?: string;
  /**
   * The server's default model for this kind, carried on every entry.
   *
   * The list is empty when the org has no models of this kind, and then there
   * is no default either — so the first entry is the only place to read it
   * from.
   */
  defaultModel?: string;
}

/**
 * Read `GET /api/media/:kind/models` into cache entries.
 *
 * The server's default model rides on EVERY entry: `defaultModel` is a
 * sibling of `data` in the envelope, and the caller needs it next to the list
 * it is already holding. A non-zero `code` is an empty list, not an error —
 * the caller treats "no models" as "nothing to pick".
 */
export function mediaModelEntriesFromListResponse(body: {
  code?: number;
  data?: unknown;
  defaultModel?: string | null;
}): MediaModelAvailabilityEntry[] {
  if (body.code !== 0) return [];
  const defaultModel = typeof body.defaultModel === 'string' && body.defaultModel
    ? canonicalizeMediaModelId(body.defaultModel)
    : '';
  const rows = Array.isArray(body.data) ? body.data : [];
  return rows.map((row) => {
    const mediaModel = row as { modelId?: string; displayName?: string };
    const modelId = canonicalizeMediaModelId(mediaModel.modelId);
    return {
      modelId,
      displayName: mediaModelDisplayName(modelId, mediaModel.displayName),
      ...(defaultModel ? { defaultModel } : {}),
    };
  });
}

export interface MediaModelAvailability {
  get(kind: 'image' | 'video', ownerAccountKey: string): Promise<MediaModelAvailabilityEntry[]>;
  clear(): void;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * Short-lived cache of the media models a server account has configured.
 *
 * The generate fallback needs the account's model list to validate the model
 * the tool named, but the LLM may retry a generate several times in one turn,
 * so the list is cached per account + kind for a minute instead of refetching
 * on every attempt.
 */
export const createMediaModelAvailabilityCache = (options: {
  fetchModels: (kind: 'image' | 'video') => Promise<MediaModelAvailabilityEntry[]>;
  ttlMs?: number;
  now?: () => number;
}): MediaModelAvailability => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; entries: MediaModelAvailabilityEntry[] }>();
  const pending = new Map<string, Promise<MediaModelAvailabilityEntry[]>>();

  const get = async (
    kind: 'image' | 'video',
    ownerAccountKey: string,
  ): Promise<MediaModelAvailabilityEntry[]> => {
    const key = `${ownerAccountKey}\u0000${kind}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) {
      return hit.entries;
    }

    const inflight = pending.get(key);
    if (inflight) {
      return inflight;
    }

    const promise = options.fetchModels(kind)
      .then((entries) => {
        cache.set(key, { expiresAt: now() + ttlMs, entries });
        pending.delete(key);
        return entries;
      })
      .catch((error) => {
        pending.delete(key);
        throw error;
      });
    pending.set(key, promise);
    return promise;
  };

  const clear = (): void => {
    cache.clear();
    pending.clear();
  };

  return { get, clear };
};
