// `OptionsV1` is a wire-protocol value exchanged with the server. The string
// literal `mixwork-options-v1` is the wire-protocol value exchanged with the
// server. Coordinated with the enterprise_server rename; the legacy value is
// no longer accepted (no dual-read).
export const MixWorkRequestCapability = {
  OptionsV1: 'mixwork-options-v1',
} as const;

export type MixWorkRequestCapability =
  typeof MixWorkRequestCapability[keyof typeof MixWorkRequestCapability];

export const MIXWORK_REQUEST_OPTIONS_FIELD = 'mixwork_options';
export const MIXWORK_REQUEST_OPTIONS_VERSION = 1;

// Client-capabilities handshake header. The desktop advertises which
// feature-gated behaviours the server may enable for this build.
// Relocated here from the deleted `modelRuntimeProfiles` module — these are
// protocol identifiers, not catalog data. The `MIXWORK_`/`X-MixWork-` naming
// is the identifier the server expects.
export const MIXWORK_CLIENT_CAPABILITIES_HEADER = 'X-MixWork-Client-Capabilities';
export const MIXWORK_CLIENT_VERSION_HEADER = 'X-MixWork-Client-Version';
export const KIMI_K3_AGENTIC_CAPABILITY = 'kimi-k3-agentic-v1';
export const THINKING_LEVEL_CONTROL_CAPABILITY = 'thinking-level-control-v1';
export const MIXWORK_CLIENT_CAPABILITIES = [
  KIMI_K3_AGENTIC_CAPABILITY,
  THINKING_LEVEL_CONTROL_CAPABILITY,
].join(',');

const MIXWORK_REQUEST_CAPABILITY_VALUES = new Set<string>(
  Object.values(MixWorkRequestCapability),
);

export const parseMixWorkRequestCapabilities = (
  value: unknown,
): MixWorkRequestCapability[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const result: MixWorkRequestCapability[] = [];
  const seen = new Set<MixWorkRequestCapability>();
  for (const candidate of value) {
    if (
      typeof candidate !== 'string'
      || !MIXWORK_REQUEST_CAPABILITY_VALUES.has(candidate)
    ) {
      continue;
    }
    const capability = candidate as MixWorkRequestCapability;
    if (!seen.has(capability)) {
      seen.add(capability);
      result.push(capability);
    }
  }
  return result.length > 0 ? result : undefined;
};

export const supportsMixWorkRequestOptionsV1 = (
  capabilities: readonly MixWorkRequestCapability[] | undefined,
): boolean => capabilities?.includes(MixWorkRequestCapability.OptionsV1) === true;
