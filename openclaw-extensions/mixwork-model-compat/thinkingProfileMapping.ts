import { MIXWORK_REQUEST_OPTIONS_VERSION } from './requestOptionsProtocol';

export const MixWorkThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
  Max: 'max',
} as const;

export type MixWorkThinkingLevel =
  typeof MixWorkThinkingLevel[keyof typeof MixWorkThinkingLevel];

export const MixWorkOpenClawThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
} as const;

export type MixWorkOpenClawThinkingLevel =
  typeof MixWorkOpenClawThinkingLevel[keyof typeof MixWorkOpenClawThinkingLevel];

export type MixWorkThinkingOption = {
  level: MixWorkThinkingLevel;
  openclawLevel: MixWorkOpenClawThinkingLevel;
};

export type MixWorkThinkingProfile = {
  options: MixWorkThinkingOption[];
  defaultLevel: MixWorkThinkingLevel;
  requestOptionsVersion?: typeof MIXWORK_REQUEST_OPTIONS_VERSION;
};

export type MixWorkThinkingProfileMap = Record<string, MixWorkThinkingProfile>;

export type MixWorkOpenClawThinkingProfile = {
  levels: Array<{ id: string; label: string }>;
  defaultLevel: string;
  preserveWhenCatalogReasoningFalse: true;
};

const LEVELS = new Set<string>(Object.values(MixWorkThinkingLevel));
const OPENCLAW_LEVELS = new Set<string>(Object.values(MixWorkOpenClawThinkingLevel));

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const isModelRef = (value: string): boolean => {
  const separatorIndex = value.indexOf('/');
  return separatorIndex > 0
    && separatorIndex < value.length - 1
    && !/\s/.test(value);
};

const parseThinkingProfile = (value: unknown): MixWorkThinkingProfile | undefined => {
  if (!isRecord(value) || !Array.isArray(value.options) || value.options.length === 0) {
    return undefined;
  }
  const options: MixWorkThinkingOption[] = [];
  const seenLevels = new Set<string>();
  const seenOpenClawLevels = new Set<string>();
  for (const rawOption of value.options) {
    if (!isRecord(rawOption)) {
      return undefined;
    }
    const { level, openclawLevel } = rawOption;
    if (
      typeof level !== 'string'
      || !LEVELS.has(level)
      || seenLevels.has(level)
      || typeof openclawLevel !== 'string'
      || !OPENCLAW_LEVELS.has(openclawLevel)
      || seenOpenClawLevels.has(openclawLevel)
      || (level === MixWorkThinkingLevel.Off)
        !== (openclawLevel === MixWorkOpenClawThinkingLevel.Off)
    ) {
      return undefined;
    }
    seenLevels.add(level);
    seenOpenClawLevels.add(openclawLevel);
    options.push({
      level: level as MixWorkThinkingLevel,
      openclawLevel: openclawLevel as MixWorkOpenClawThinkingLevel,
    });
  }
  if (options.length === 1 && options[0]?.level === MixWorkThinkingLevel.Off) {
    return undefined;
  }
  if (typeof value.defaultLevel !== 'string' || !seenLevels.has(value.defaultLevel)) {
    return undefined;
  }
  return {
    options,
    defaultLevel: value.defaultLevel as MixWorkThinkingLevel,
    ...(value.requestOptionsVersion === MIXWORK_REQUEST_OPTIONS_VERSION
      ? { requestOptionsVersion: MIXWORK_REQUEST_OPTIONS_VERSION }
      : {}),
  };
};

export const parseThinkingProfileMap = (value: unknown): MixWorkThinkingProfileMap => {
  if (!isRecord(value)) return {};
  const result: MixWorkThinkingProfileMap = {};
  for (const [modelRef, rawProfile] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right))) {
    const profile = parseThinkingProfile(rawProfile);
    if (isModelRef(modelRef) && profile) {
      result[modelRef] = profile;
    }
  }
  return result;
};

export const resolveOpenClawThinkingProfile = (
  profile: MixWorkThinkingProfile | undefined,
  hasKimiK3RuntimeProfile: boolean,
): MixWorkOpenClawThinkingProfile | undefined => {
  if (profile) {
    const defaultOpenClawLevel = profile.options.find(
      option => option.level === profile.defaultLevel,
    )?.openclawLevel;
    if (!defaultOpenClawLevel) return undefined;
    return {
      levels: profile.options.map(option => ({
        id: option.openclawLevel,
        label: option.level,
      })),
      defaultLevel: defaultOpenClawLevel,
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  if (!hasKimiK3RuntimeProfile) return undefined;
  return {
    levels: [{ id: 'max', label: 'max' }],
    defaultLevel: 'max',
    preserveWhenCatalogReasoningFalse: true,
  };
};
