import { describe, expect, test } from 'vitest';

import { AGENT_COLUMNS, mapAgent } from '../../src/models/agentMarketplaceView';

describe('agentMarketplaceView', () => {
  test('AGENT_COLUMNS covers every wire field', () => {
    // Lightweight: assert no duplicates and that the visibility column is
    // included. The role grant was replaced by the department scope.
    const cols = AGENT_COLUMNS.split(',').map(s => s.trim());
    expect(new Set(cols).size).toBe(cols.length);
    expect(cols).toContain('scope');
    expect(cols).not.toContain('allowed_roles');
    expect(cols).toContain('agent_id');
  });

  test('mapAgent maps snake row -> camel wire, defaulting missing fields', () => {
    const v = mapAgent({
      agent_id: 'agent_a1',
      name: 'Code Reviewer',
      description: 'Reviews PRs',
      identity: '',
      system_prompt: '',
      model: '',
      thinking_level: '',
      icon: '',
      skill_ids: ['web-search'],
      subagent_allow_agent_ids: ['agent_a2'],
      scope: { allCompany: false, deptIds: ['d1'], userIds: ['u1'] },
      enabled: true,
      about_you: '',
      icon_color: 0,
      im_channels: ['feishu', 'weixin'],
    });
    expect(v).toEqual({
      agentId: 'agent_a1',
      name: 'Code Reviewer',
      description: 'Reviews PRs',
      identity: '',
      systemPrompt: '',
      model: '',
      thinkingLevel: '',
      icon: '',
      skillIds: ['web-search'],
      subagentAllowAgentIds: ['agent_a2'],
      scope: { allCompany: false, deptIds: ['d1'], userIds: ['u1'] },
      enabled: true,
      aboutYou: '',
      iconColor: 0,
      imChannels: ['feishu', 'weixin'],
    });
  });

  test('mapAgent tolerates null array columns', () => {
    const v = mapAgent({
      agent_id: 'a', name: 'A', description: '', identity: '', system_prompt: '',
      model: '', thinking_level: '', icon: '',
      // null array columns: AgentRow types them as nullable for legacy rows,
      // and mapAgent must default them to [].
      skill_ids: null, subagent_allow_agent_ids: null,
      scope: { allCompany: false, deptIds: [], userIds: [] }, enabled: false,
      about_you: '', icon_color: 0, im_channels: null,
    });
    expect(v.skillIds).toEqual([]);
    expect(v.subagentAllowAgentIds).toEqual([]);
    expect(v.imChannels).toEqual([]);
  });

  test('mapAgent maps about_you and icon_color, defaulting missing values', () => {
    const v = mapAgent({
      agent_id: 'a', name: 'A', description: '', identity: '', system_prompt: '',
      model: '', thinking_level: '', icon: '',
      skill_ids: null, subagent_allow_agent_ids: null,
      scope: { allCompany: false, deptIds: [], userIds: [] }, enabled: true,
      about_you: '我叫王经理', icon_color: 3, im_channels: ['wecom'],
    });
    expect(v.aboutYou).toBe('我叫王经理');
    expect(v.iconColor).toBe(3);
    expect(v.imChannels).toEqual(['wecom']);
  });

  test('AGENT_COLUMNS includes about_you and icon_color', () => {
    const cols = AGENT_COLUMNS.split(',').map(s => s.trim());
    expect(cols).toContain('about_you');
    expect(cols).toContain('icon_color');
  });

  test('AGENT_COLUMNS includes im_channels', () => {
    const cols = AGENT_COLUMNS.split(',').map(s => s.trim());
    expect(cols).toContain('im_channels');
  });
});
