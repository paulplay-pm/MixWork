/**
 * Brand artwork for the built-in skills and connectors.
 *
 * The files live under `public/` and are referenced by path with no leading
 * slash — the same convention the IM platform registry uses
 * (`PlatformRegistry.logo()` returns `'weixin.png'`). A relative path resolves
 * against the app root in the dev server and in the packaged renderer alike.
 *
 * Two sources feed this map: the artwork already in the repository (the WeCom
 * mark, the mail glyph) and the brand marks published by the Simple Icons and
 * Iconify collections. Both are the vendors' own marks, used here to say which
 * service a skill talks to.
 *
 * A skill with no brand — an internal workflow, a generic capability — falls
 * back to a generated monogram: a stable colour and the initials of its
 * name. That reads better than the same generic glyph for every row, and it
 * is obvious when a row is waiting for real artwork.
 */

/** Built-in skill id → the artwork that represents it. */
const SKILL_ICONS: Record<string, string> = {
  '1password': 'brand-icons/1password.svg',
  'apple-notes': 'brand-icons/apple.svg',
  'apple-reminders': 'brand-icons/apple.svg',
  'baidu-netdisk': 'brand-icons/baidu.svg',
  'baoyu-post-to-wechat': 'brand-icons/wechat.svg',
  'brave-search': 'brand-icons/brave.svg',
  'diagram-generator': 'brand-icons/mermaid.svg',
  'edge-tts': 'brand-icons/microsoft-edge.svg',
  'ffmpeg-video-editor': 'brand-icons/ffmpeg.svg',
  'figma': 'brand-icons/figma.svg',
  'flyai': 'brand-icons/bytedance.svg',
  'github': 'brand-icons/github.svg',
  'github-deep-research': 'brand-icons/github.svg',
  'home-assistant': 'brand-icons/homeassistant.svg',
  'imap-smtp-email': 'email.svg',
  'meituan-coupon-lobsterai': 'brand-icons/meituan.svg',
  'minimax-music-gen': 'brand-icons/minimax.svg',
  'mmx-cli': 'brand-icons/minimax.svg',
  'nano-banana-pro': 'brand-icons/googlegemini.svg',
  'notion': 'brand-icons/notion.svg',
  'obsidian': 'brand-icons/obsidian.svg',
  'openai-image-gen': 'brand-icons/openai.svg',
  'openai-whisper': 'brand-icons/openai.svg',
  'playwright': 'brand-icons/playwright.svg',
  'qwen-image': 'brand-icons/qwen.svg',
  'seedance': 'brand-icons/bytedance.svg',
  'seedream': 'brand-icons/bytedance.svg',
  'slack-gif-creator': 'brand-icons/slack.svg',
  'taobao-native': 'brand-icons/taobao.svg',
  'wecom-unified': 'wecom.png',
};

/** Built-in connector id → the artwork that represents it. */
const CONNECTOR_ICONS: Record<string, string> = {
  'airtable': 'brand-icons/airtable.svg',
  'brave-search': 'brand-icons/brave.svg',
  'figma': 'brand-icons/figma.svg',
  'firecrawl': 'brand-icons/firecrawl.svg',
  'github': 'brand-icons/github.svg',
  'gmail': 'brand-icons/google-gmail.svg',
  'google-calendar': 'brand-icons/google-calendar.svg',
  'google-drive': 'brand-icons/google-drive.svg',
  'mcp-gitlab': 'brand-icons/gitlab.svg',
  'notion': 'brand-icons/notion.svg',
  'playwright': 'brand-icons/playwright.svg',
  'puppeteer': 'brand-icons/puppeteer.svg',
  'slack': 'brand-icons/slack.svg',
  'tavily': 'brand-icons/tavily.svg',
  'todoist': 'brand-icons/todoist.svg',
};

/** The bundled icon file for a built-in skill, or undefined. */
export function builtinSkillIcon(skillId: string): string | undefined {
  return SKILL_ICONS[skillId];
}

/** The bundled icon file for a built-in connector, or undefined. */
export function builtinConnectorIcon(connectorId: string): string | undefined {
  return CONNECTOR_ICONS[connectorId];
}

/** Whether an icon path points at one of the bundled brand marks. Those are
 *  drawn on a white tile, because a vendor mark is drawn for a light
 *  background and disappears on the app's dark one. */
export function isBundledBrandIcon(icon: string | undefined): boolean {
  return !!icon && icon.startsWith('brand-icons/');
}

export interface Monogram {
  /** One or two characters. */
  text: string;
  /** Hue in degrees; the same seed always gives the same hue. */
  hue: number;
}

/**
 * A generated stand-in for a brand that has no artwork: the initials of the
 * name on a colour derived from the id.
 *
 * The id is the seed rather than the name on purpose — the name can be
 * translated, and a row that changed colour when the UI language changed
 * would look broken.
 */
export function monogramFor(seed: string, label?: string): Monogram {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;

  const text = (label ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  if (text) return { text, hue };

  // A CJK name has no spaces to take initials from; its first character is
  // the mark.
  const first = (label ?? seed).trim()[0];
  return { text: first ? first.toUpperCase() : '?', hue };
}
