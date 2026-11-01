import { describe, expect, test } from 'vitest';

import type { Agent } from '../mixcworkStore';
import { effectiveAgentModelRef } from './agentModelOverride';

const base: Agent = {
  id: 'a1', name: 'A', description: '', systemPrompt: '', identity: '', aboutYou: '',
  model: 'mixcwork/server-model', thinkingLevel: 'medium', workingDirectory: '', icon: '',
  skillIds: [], subagentAllowAgentIds: [], serverSkillIds: [], serverSubagentAllowAgentIds: [],
  serverImChannels: [], enabled: true, pinned: false, pinOrder: null, sortOrder: null,
  isDefault: false, source: 'enterprise', presetId: '', enterpriseAgentId: 'srv-1',
  createdAt: 0, updatedAt: 0,
};

describe('effectiveAgentModelRef', () => {
  test('enterprise: parseable override wins', () => {
    expect(effectiveAgentModelRef(base, () => 'mixcwork/other')).toBe('mixcwork/other');
  });
  test('enterprise: unparseable/empty override falls back to the row model', () => {
    expect(effectiveAgentModelRef(base, () => 'not-a-ref')).toBe('mixcwork/server-model');
    expect(effectiveAgentModelRef(base, () => '')).toBe('mixcwork/server-model');
  });
  test('non-enterprise: always the row model', () => {
    expect(effectiveAgentModelRef({ ...base, source: 'custom', enterpriseAgentId: undefined }, () => 'mixcwork/other')).toBe('mixcwork/server-model');
  });
});
