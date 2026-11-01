import { describe, expect, test } from 'vitest';

import { isMixcworkDesktopSessionKey } from '../../../openclaw-extensions/mixcwork-media-generation/sessionKey';

describe('mixcwork-media-generation session key gating', () => {
  test('allows main agent desktop sessions', () => {
    expect(isMixcworkDesktopSessionKey('agent:main:mixcwork:session-1')).toBe(true);
  });

  test('allows non-main agent desktop sessions', () => {
    expect(isMixcworkDesktopSessionKey('agent:creative-agent:mixcwork:session-2')).toBe(true);
  });

  test('allows materialized subagent child sessions', () => {
    expect(isMixcworkDesktopSessionKey('agent:creative-agent:subagent:run-1')).toBe(true);
  });

  test('allows legacy desktop sessions', () => {
    expect(isMixcworkDesktopSessionKey('mixcwork:session-3')).toBe(true);
  });

  test('rejects channel and malformed session keys', () => {
    expect(isMixcworkDesktopSessionKey('agent:creative-agent:dingtalk-connector:direct:user-1')).toBe(false);
    expect(isMixcworkDesktopSessionKey('')).toBe(false);
    expect(isMixcworkDesktopSessionKey('agent::mixcwork:session-4')).toBe(false);
    expect(isMixcworkDesktopSessionKey('agent:creative-agent:mixcwork:')).toBe(false);
    expect(isMixcworkDesktopSessionKey('agent:creative-agent')).toBe(false);
  });
});