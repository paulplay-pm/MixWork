import { MinimaxImageProvider, MinimaxVideoProvider } from './providers/minimax';
import type { MediaProvider } from './types';

/**
 * protocol → adapter, mirroring the ASR registry: the key is the ADAPTER
 * (`image-gen` / `video-gen`), not a vendor, so adding a supplier is a config
 * change rather than a code change.
 */
const REGISTRY = new Map<string, MediaProvider>([
  ['image-gen', new MinimaxImageProvider()],
  ['video-gen', new MinimaxVideoProvider()],
]);

export function getMediaProvider(protocol: string | null | undefined): MediaProvider | undefined {
  if (!protocol) return undefined;
  return REGISTRY.get(protocol);
}

export function mediaProtocols(): string[] {
  return [...REGISTRY.keys()];
}
