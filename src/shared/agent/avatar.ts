export const AgentAvatarIconFormat = {
  Svg: 'agent-avatar-svg',
} as const;

export type AgentAvatarIconFormat = typeof AgentAvatarIconFormat[keyof typeof AgentAvatarIconFormat];

export const AgentAvatarIconSeparator = {
  Value: ':',
} as const;

export const AgentAvatarSvg = {
  Mixcwork: 'mixcwork',
  Code: 'code',
  Repair: 'repair',
  Briefcase: 'briefcase',
  ShoppingCart: 'shopping-cart',
  Data: 'data',
  Document: 'document',
  Folder: 'folder',
  Tag: 'tag',
  Brain: 'brain',
  GraduationCap: 'graduation-cap',
  Books: 'books',
  Experiment: 'experiment',
  Diagnosis: 'diagnosis',
  Scales: 'scales',
  Translation: 'translation',
  TranslationAlt: 'translation-alt',
  Creation: 'creation',
  Artboard: 'artboard',
  Music: 'music',
  Entertainment: 'entertainment',
  Headphones: 'headphones',
  Inspiration: 'inspiration',
  Lightning: 'lightning',
  Travel: 'travel',
  Fitness: 'fitness',
  Meditation: 'meditation',
  Heart: 'heart',
  PottedPlant: 'potted-plant',
  Pet: 'pet',
} as const;

export type AgentAvatarSvg = typeof AgentAvatarSvg[keyof typeof AgentAvatarSvg];

export interface DesignedAgentAvatar {
  svg: AgentAvatarSvg;
}

const AGENT_AVATAR_PART_COUNT = 2;

const AGENT_AVATAR_SVGS = new Set<string>(Object.values(AgentAvatarSvg));

/** The tint an org agent may carry, as an index into this palette. Mirrors
 *  the Enterprise console's swatches; -1 (or anything out of range) means the
 *  avatar keeps following the theme. */
export const AgentAvatarColors = [
  '#2563eb', '#0f766e', '#b45309', '#7c3aed', '#dc2626', '#0ea5e9', '#16a34a', '#db2777',
] as const;

/** The colour for a stored tint index, or null when there is none. */
export const agentAvatarColor = (index: number | null | undefined): string | null => {
  if (typeof index !== 'number' || index < 0 || index >= AgentAvatarColors.length) return null;
  return AgentAvatarColors[index] ?? null;
};

export const DefaultAgentAvatar = {
  svg: AgentAvatarSvg.Mixcwork,
} as const satisfies DesignedAgentAvatar;

export const isAgentAvatarSvg = (value: string): value is AgentAvatarSvg => {
  return AGENT_AVATAR_SVGS.has(value);
};

const LegacyAgentAvatarIconFormat = {
  Designed: 'agent-avatar',
} as const;

export const encodeAgentAvatarIcon = (avatar: DesignedAgentAvatar): string => {
  return [
    AgentAvatarIconFormat.Svg,
    avatar.svg,
  ].join(AgentAvatarIconSeparator.Value);
};

export const DefaultAgentAvatarIcon = encodeAgentAvatarIcon(DefaultAgentAvatar);

export const parseAgentAvatarIcon = (value: string | null | undefined): DesignedAgentAvatar | null => {
  const normalized = value?.trim() ?? '';
  if (!normalized) return null;

  const parts = normalized.split(AgentAvatarIconSeparator.Value);
  if (parts[0] === LegacyAgentAvatarIconFormat.Designed) {
    return null;
  }

  if (parts.length !== AGENT_AVATAR_PART_COUNT) return null;

  const [format, svg] = parts;
  if (format !== AgentAvatarIconFormat.Svg) return null;
  if (!isAgentAvatarSvg(svg)) return null;

  return { svg };
};

export const isDesignedAgentAvatarIcon = (value: string | null | undefined): boolean => {
  return parseAgentAvatarIcon(value) !== null;
};

/**
 * An icon that is a picture rather than one of the built-in avatars.
 *
 * The enterprise console lets an org upload a logo for its agents, and stores
 * it as a path the enterprise server serves. Those arrive here as a URL, and
 * they are the only other shape an agent icon may take.
 */
export const isAgentIconImage = (value: string | null | undefined): boolean => {
  const normalized = value?.trim() ?? '';
  return /^(https?:|data:image\/|\/)/i.test(normalized);
};

export const normalizeAgentAvatarIcon = (value: string | null | undefined): string => {
  const normalized = value?.trim() ?? '';
  const avatar = parseAgentAvatarIcon(normalized);
  if (avatar) return encodeAgentAvatarIcon(avatar);
  // An uploaded icon is kept as-is; anything else is not a usable icon and
  // becomes the default avatar.
  if (isAgentIconImage(normalized)) return normalized;
  return DefaultAgentAvatarIcon;
};
