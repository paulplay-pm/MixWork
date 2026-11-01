import { MIXCWORK_REQUEST_OPTIONS_VERSION } from './requestOptionsProtocol';

export const MixcworkThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
  Max: 'max',
} as const;

export type MixcworkThinkingLevel =
  typeof MixcworkThinkingLevel[keyof typeof MixcworkThinkingLevel];

export const MixcworkOpenClawThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
} as const;

export type MixcworkOpenClawThinkingLevel =
  typeof MixcworkOpenClawThinkingLevel[keyof typeof MixcworkOpenClawThinkingLevel];

export type MixcworkThinkingOption = {
  level: MixcworkThinkingLevel;
  openclawLevel: MixcworkOpenClawThinkingLevel;
};

export type MixcworkThinkingProfile = {
  options: MixcworkThinkingOption[];
  defaultLevel: MixcworkThinkingLevel;
  requestOptionsVersion?: typeof MIXCWORK_REQUEST_OPTIONS_VERSION;
};

export type MixcworkThinkingProfileMap = Record<string, MixcworkThinkingProfile>;

export type MixcworkOpenClawThinkingProfile = {
  levels: Array<{ id: string; label: string }>;
  defaultLevel: string;
  preserveWhenCatalogReasoningFalse: true;
};

const LEVELS = new Set<string>(Object.values(MixcworkThinkingLevel));
const OPENCLAW_LEVELS = new Set<string>(Object.values(MixcworkOpenClawThinkingLevel));

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const isModelRef = (value: string): boolean => {
  const separatorIndex = value.indexOf('/');
  return separatorIndex > 0
    && separatorIndex < value.length - 1
    && !/\s/.test(value);
};

const parseThinkingProfile = (value: unknown): MixcworkThinkingProfile | undefined => {
  if (!isRecord(value) || !Array.isArray(value.options) || value.options.length === 0) {
    return undefined;
  }
  const options: MixcworkThinkingOption[] = [];
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
      || (level === MixcworkThinkingLevel.Off)
        !== (openclawLevel === MixcworkOpenClawThinkingLevel.Off)
    ) {
      return undefined;
    }
    seenLevels.add(level);
    seenOpenClawLevels.add(openclawLevel);
    options.push({
      level: level as MixcworkThinkingLevel,
      openclawLevel: openclawLevel as MixcworkOpenClawThinkingLevel,
    });
  }
  if (options.length === 1 && options[0]?.level === MixcworkThinkingLevel.Off) {
    return undefined;
  }
  if (typeof value.defaultLevel !== 'string' || !seenLevels.has(value.defaultLevel)) {
    return undefined;
  }
  return {
    options,
    defaultLevel: value.defaultLevel as MixcworkThinkingLevel,
    ...(value.requestOptionsVersion === MIXCWORK_REQUEST_OPTIONS_VERSION
      ? { requestOptionsVersion: MIXCWORK_REQUEST_OPTIONS_VERSION }
      : {}),
  };
};

export const parseThinkingProfileMap = (value: unknown): MixcworkThinkingProfileMap => {
  if (!isRecord(value)) return {};
  const result: MixcworkThinkingProfileMap = {};
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
  profile: MixcworkThinkingProfile | undefined,
  hasKimiK3RuntimeProfile: boolean,
): MixcworkOpenClawThinkingProfile | undefined => {
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
