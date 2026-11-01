import { describe, expect, test } from 'vitest';

import {
  AgentAvatarSvg,
  DefaultAgentAvatar,
  DefaultAgentAvatarIcon,
  encodeAgentAvatarIcon,
  isAgentIconImage,
  isDesignedAgentAvatarIcon,
  normalizeAgentAvatarIcon,
  parseAgentAvatarIcon,
} from './avatar';

describe('agent avatar icon encoding', () => {
  test('round-trips svg avatar selections', () => {
    const value = encodeAgentAvatarIcon({
      svg: AgentAvatarSvg.Code,
    });

    expect(parseAgentAvatarIcon(value)).toEqual({
      svg: AgentAvatarSvg.Code,
    });
  });

  test('exposes the default svg avatar icon', () => {
    expect(parseAgentAvatarIcon(DefaultAgentAvatarIcon)).toEqual(DefaultAgentAvatar);
  });

  test('leaves legacy emoji icons untouched', () => {
    expect(parseAgentAvatarIcon('🤖')).toBeNull();
    expect(isDesignedAgentAvatarIcon('🤖')).toBe(false);
  });

  test('normalizes empty and legacy icons to the default svg avatar', () => {
    expect(normalizeAgentAvatarIcon('')).toBe(DefaultAgentAvatarIcon);
    expect(normalizeAgentAvatarIcon('legacy-icon')).toBe(DefaultAgentAvatarIcon);
    expect(normalizeAgentAvatarIcon('agent-avatar:blue:code')).toBe(DefaultAgentAvatarIcon);
    expect(normalizeAgentAvatarIcon('agent-avatar:blue:missing')).toBe(DefaultAgentAvatarIcon);
  });

  test('preserves valid svg avatars when normalizing', () => {
    const value = encodeAgentAvatarIcon({
      svg: AgentAvatarSvg.Brain,
    });

    expect(normalizeAgentAvatarIcon(` ${value} `)).toBe(value);
  });

  test('rejects malformed avatar values', () => {
    expect(parseAgentAvatarIcon('agent-avatar:blue:code')).toBeNull();
    expect(parseAgentAvatarIcon('agent-avatar:blue:missing')).toBeNull();
    expect(parseAgentAvatarIcon('agent-avatar:missing:code')).toBeNull();
    expect(parseAgentAvatarIcon('agent-avatar-svg:missing')).toBeNull();
  });
});

describe('an org-uploaded agent icon', () => {
  test('is recognized as an image, not as a broken avatar', () => {
    expect(isAgentIconImage('/agent-icons/uploads/a1.png')).toBe(true);
    expect(isAgentIconImage('https://org.example.com/agent-icons/uploads/a1.png')).toBe(true);
    expect(isAgentIconImage('data:image/png;base64,AA')).toBe(true);
    expect(isAgentIconImage('agent-avatar-svg:code')).toBe(false);
    expect(isAgentIconImage('')).toBe(false);
  });

  test('survives normalization instead of collapsing to the default avatar', () => {
    // The enterprise console stores an uploaded logo as a served path; the
    // agent record must keep it or the desktop shows the generic avatar.
    expect(normalizeAgentAvatarIcon('/agent-icons/uploads/a1.png'))
      .toBe('/agent-icons/uploads/a1.png');
  });
});
