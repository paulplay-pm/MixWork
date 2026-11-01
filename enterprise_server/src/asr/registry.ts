import { MinimaxAsrProvider } from './providers/minimax';
import type { AsrProvider } from './types';

/**
 * protocol → adapter. The key is `provider_keys.protocol`, i.e. the ADAPTER,
 * never a vendor slug: `realtime-asr` is "speak the OpenAI-style realtime
 * dialect", which MiniMax (today) and someone else (tomorrow) may both
 * implement. Keying on the vendor would force a code change to add a supplier.
 */
const REGISTRY = new Map<string, AsrProvider>([
  ['realtime-asr', new MinimaxAsrProvider()],
]);

export function getAsrProvider(protocol: string | null | undefined): AsrProvider | undefined {
  if (!protocol) return undefined;
  return REGISTRY.get(protocol);
}

export function hasAsrProvider(protocol: string | null | undefined): boolean {
  return getAsrProvider(protocol) !== undefined;
}

/** Registered protocol names, for admin UIs that offer a picker. */
export function asrProtocols(): string[] {
  return [...REGISTRY.keys()];
}