import { describe, expect, test } from 'vitest';

import {
  AGENT_AVATARS,
  AGENT_COLORS,
  AGENT_GLYPHS,
  agentAvatarUrl,
  encodeAgentAvatar,
  isImageIcon,
  parseAgentAvatar,
  tileStyle,
} from '../../../src/pages/agentManage/agentTile';

describe('agentTile', () => {
  test('has 8 colors and at least 5 legacy glyphs', () => {
    expect(AGENT_COLORS).toHaveLength(8);
    expect(AGENT_GLYPHS.length).toBeGreaterThanOrEqual(5);
  });

  test('offers the desktop\'s built-in avatars', () => {
    // The list has to mirror the desktop's set: an avatar it does not know is
    // silently replaced with the default one on that side.
    expect(AGENT_AVATARS.length).toBe(30);
    expect(AGENT_AVATARS).toContain('code');
    expect(AGENT_AVATARS).toContain('mixcwork');
  });

  test('encodes the value in the form the desktop parses', () => {
    const encoded = encodeAgentAvatar('code');
    expect(encoded).toBe('agent-avatar-svg:code');
    expect(parseAgentAvatar(encoded)).toBe('code');
  });

  test('rejects anything that is not a known avatar', () => {
    expect(parseAgentAvatar('agent-avatar-svg:nope')).toBeNull();
    expect(parseAgentAvatar('bot')).toBeNull();
    expect(parseAgentAvatar('')).toBeNull();
    expect(parseAgentAvatar('https://cdn/x.png')).toBeNull();
  });

  test('serves the avatar from an absolute path', () => {
    // Relative would resolve against the SPA's current route, so the mask
    // would 404 everywhere except the root.
    expect(agentAvatarUrl('code')).toBe('/agent-avatars/code.svg');
  });

  test('isImageIcon covers uploads as well as legacy absolute URLs', () => {
    expect(isImageIcon('https://x/y.png')).toBe(true);
    expect(isImageIcon('data:image/png;base64,AA')).toBe(true);
    // An uploaded icon is stored as a path this server serves.
    expect(isImageIcon('/agent-icons/uploads/a1.png')).toBe(true);
    expect(isImageIcon('agent-icons/uploads/a1.png')).toBe(true);
    expect(isImageIcon('agent-avatar-svg:code')).toBe(false);
    expect(isImageIcon('bot')).toBe(false);
    expect(isImageIcon('')).toBe(false);
  });

  test('tileStyle returns a real colour, wrapping out-of-range indices', () => {
    // The regression this guards: the tint used to be a Tailwind class built
    // at runtime, which the JIT never emits — the colour picker did nothing.
    const style = tileStyle(0);
    expect(style.color).toBe(AGENT_COLORS[0]);
    expect(style.backgroundColor).toContain(AGENT_COLORS[0]!);
    expect(tileStyle(9)).toEqual(tileStyle(9 % 8));
  });
});
