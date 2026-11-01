// `OptionsV1` is a wire-protocol value exchanged with the server. The string
// literal `mixcwork-options-v1` is the wire-protocol value exchanged with the
// server. Coordinated with the enterprise_server rename; the legacy value is
// no longer accepted (no dual-read).
export const MixCWorkRequestCapability = {
  OptionsV1: 'mixcwork-options-v1',
} as const;

export type MixCWorkRequestCapability =
  typeof MixCWorkRequestCapability[keyof typeof MixCWorkRequestCapability];

export const MIXCWORK_REQUEST_OPTIONS_FIELD = 'mixcwork_options';
export const MIXCWORK_REQUEST_OPTIONS_VERSION = 1;

// Client-capabilities handshake header. The desktop advertises which
// feature-gated behaviours the server may enable for this build.
// Relocated here from the deleted `modelRuntimeProfiles` module — these are
// protocol identifiers, not catalog data. The `MIXCWORK_`/`X-Mixcwork-` naming
// is the identifier the server expects.
export const MIXCWORK_CLIENT_CAPABILITIES_HEADER = 'X-Mixcwork-Client-Capabilities';
export const MIXCWORK_CLIENT_VERSION_HEADER = 'X-Mixcwork-Client-Version';
export const KIMI_K3_AGENTIC_CAPABILITY = 'kimi-k3-agentic-v1';
export const THINKING_LEVEL_CONTROL_CAPABILITY = 'thinking-level-control-v1';
export const MIXCWORK_CLIENT_CAPABILITIES = [
  KIMI_K3_AGENTIC_CAPABILITY,
  THINKING_LEVEL_CONTROL_CAPABILITY,
].join(',');

const MIXCWORK_REQUEST_CAPABILITY_VALUES = new Set<string>(
  Object.values(MixCWorkRequestCapability),
);

export const parseMixCWorkRequestCapabilities = (
  value: unknown,
): MixCWorkRequestCapability[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const result: MixCWorkRequestCapability[] = [];
  const seen = new Set<MixCWorkRequestCapability>();
  for (const candidate of value) {
    if (
      typeof candidate !== 'string'
      || !MIXCWORK_REQUEST_CAPABILITY_VALUES.has(candidate)
    ) {
      continue;
    }
    const capability = candidate as MixCWorkRequestCapability;
    if (!seen.has(capability)) {
      seen.add(capability);
      result.push(capability);
    }
  }
  return result.length > 0 ? result : undefined;
};

export const supportsMixCWorkRequestOptionsV1 = (
  capabilities: readonly MixCWorkRequestCapability[] | undefined,
): boolean => capabilities?.includes(MixCWorkRequestCapability.OptionsV1) === true;
