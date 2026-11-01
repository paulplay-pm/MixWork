import type { LucideIcon } from 'lucide-react';
import { BarChart3, Bot, Code2, FileText, Globe, Megaphone, Mic, Sparkles } from 'lucide-react';
import type { CSSProperties } from 'react';

/** Glyph names offered by the icon picker. Each maps to a lucide icon in the
 *  tile renderer. Matches the prototype's small glyph set. */
export const AGENT_GLYPHS: string[] = ['bot', 'chart', 'doc', 'code', 'meg', 'mic', 'globe', 'spark'];

/** 8-tint palette for the tile (app tokens where they exist, else the
 *  prototype's hues). Indexed by `icon_color`. */
export const AGENT_COLORS: string[] = [
  '#2563eb', '#0f766e', '#b45309', '#7c3aed', '#dc2626', '#0ea5e9', '#16a34a', '#db2777',
];

/** Maps the icon-picker glyph names (AGENT_GLYPHS) to lucide icons. Single
 *  source of truth for the glyph→icon rule, shared by the card, the drawer
 *  tile, and the icon/color picker. */
export const GLYPH_ICON: Record<string, LucideIcon> = {
  bot: Bot,
  chart: BarChart3,
  doc: FileText,
  code: Code2,
  meg: Megaphone,
  mic: Mic,
  globe: Globe,
  spark: Sparkles,
};

/** The built-in agent avatars, named exactly as the desktop names them. The
 *  SVGs ship in `public/agent-avatars/` and the value is stored with the
 *  `agent-avatar-svg:` prefix the desktop already parses, so an icon chosen
 *  here renders there without another mapping. */
export const AGENT_AVATARS: string[] = [
  'mixcwork', 'code', 'repair', 'briefcase', 'shopping-cart', 'data', 'document',
  'folder', 'tag', 'brain', 'graduation-cap', 'books', 'experiment', 'diagnosis',
  'scales', 'translation', 'translation-alt', 'creation', 'artboard', 'music',
  'entertainment', 'headphones', 'inspiration', 'lightning', 'travel', 'fitness',
  'meditation', 'heart', 'potted-plant', 'pet',
];

const AGENT_AVATAR_PREFIX = 'agent-avatar-svg';

/** `agent-avatar-svg:code` for a built-in avatar. */
export function encodeAgentAvatar(name: string): string {
  return `${AGENT_AVATAR_PREFIX}:${name}`;
}

/** The avatar's name, or null when the value is not a built-in avatar. */
export function parseAgentAvatar(icon: string): string | null {
  const [prefix, name] = icon.split(':');
  if (prefix !== AGENT_AVATAR_PREFIX || !name) return null;
  return AGENT_AVATARS.includes(name) ? name : null;
}

/** Where the console serves the avatar's SVG.
 *
 *  Absolute on purpose: a relative URL inside a CSS `url()` resolves against
 *  the SPA's current route, so `/agents/agent-avatars/code.svg` would 404 on
 *  every surface except the root. */
export function agentAvatarUrl(name: string): string {
  return `/agent-avatars/${name}.svg`;
}

/** The style that paints an avatar with the surrounding text colour. The SVGs
 *  are stroke-only, so masking them keeps them legible on any tile tint — the
 *  same trick the desktop uses. */
export function avatarMaskStyle(name: string): CSSProperties {
  const url = agentAvatarUrl(name);
  return {
    WebkitMaskImage: `url("${url}")`,
    WebkitMaskPosition: 'center',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskSize: 'contain',
    maskImage: `url("${url}")`,
    maskPosition: 'center',
    maskRepeat: 'no-repeat',
    maskSize: 'contain',
    backgroundColor: 'currentColor',
  };
}

/** An image the admin uploaded (or a legacy absolute URL), as opposed to a
 *  built-in avatar or one of the old glyph names. */
export function isImageIcon(icon: string): boolean {
  return /^(https?:|data:|\/?agent-icons\/)/i.test(icon);
}

/** The tint for a tile at `iconColor`.
 *
 *  Inline rather than a Tailwind class: the palette lives in this file, so the
 *  class names would be built at runtime and the JIT would never emit them —
 *  which is why the colour picker appeared to do nothing. */
export function tileStyle(iconColor: number): CSSProperties {
  const c = AGENT_COLORS[((iconColor % AGENT_COLORS.length) + AGENT_COLORS.length) % AGENT_COLORS.length];
  return { backgroundColor: `${c}1f`, color: c, borderColor: `${c}33` };
}
