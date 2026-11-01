import { describe, expect, test } from 'vitest';

import { isMixWorkDesktopSessionKey } from '../../../openclaw-extensions/mixwork-media-generation/sessionKey';

describe('mixwork-media-generation session key gating', () => {
  test('allows main agent desktop sessions', () => {
    expect(isMixWorkDesktopSessionKey('agent:main:mixwork:session-1')).toBe(true);
  });

  test('allows non-main agent desktop sessions', () => {
    expect(isMixWorkDesktopSessionKey('agent:creative-agent:mixwork:session-2')).toBe(true);
  });

  test('allows materialized subagent child sessions', () => {
    expect(isMixWorkDesktopSessionKey('agent:creative-agent:subagent:run-1')).toBe(true);
  });

  test('allows legacy desktop sessions', () => {
    expect(isMixWorkDesktopSessionKey('mixwork:session-3')).toBe(true);
  });

  test('rejects channel and malformed session keys', () => {
    expect(isMixWorkDesktopSessionKey('agent:creative-agent:dingtalk-connector:direct:user-1')).toBe(false);
    expect(isMixWorkDesktopSessionKey('')).toBe(false);
    expect(isMixWorkDesktopSessionKey('agent::mixwork:session-4')).toBe(false);
    expect(isMixWorkDesktopSessionKey('agent:creative-agent:mixwork:')).toBe(false);
    expect(isMixWorkDesktopSessionKey('agent:creative-agent')).toBe(false);
  });
});