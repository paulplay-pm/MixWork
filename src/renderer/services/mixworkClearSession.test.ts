import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { store } from '../store';
import { setAgents, setCurrentAgentId } from '../store/slices/agentSlice';
import { setCurrentSession } from '../store/slices/mixworkSlice';
import { clearActiveSkills, setActiveSkillIds } from '../store/slices/skillSlice';
import { type MixWorkSession,MixWorkSessionStatusValue } from '../types/mixwork';
import { mixworkService } from './mixwork';

const makeSession = (): MixWorkSession => ({
  id: 'session-1',
  title: 'Session 1',
  openclawSessionId: null,
  scheduledTaskId: null,
  status: MixWorkSessionStatusValue.Running,
  pinned: false,
  pinOrder: null,
  cwd: '/tmp',
  systemPrompt: '',
  modelOverride: '',
  executionMode: 'local',
  activeSkillIds: [],
  agentId: 'agent-1',
  messages: [],
  messagesOffset: 0,
  totalMessages: 0,
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  store.dispatch(setAgents([]));
  store.dispatch(setCurrentAgentId('main'));
  store.dispatch(setCurrentSession(null));
  store.dispatch(clearActiveSkills());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mixworkService.clearSession', () => {
  test('restores the current agent default skills for a new task', () => {
    store.dispatch(setAgents([{
      id: 'agent-1',
      name: 'Agent 1',
      description: '',
      aboutYou: '',
      icon: '',
      model: '',
      thinkingLevel: '',
      workingDirectory: '',
      enabled: true,
      pinned: false,
      pinOrder: null,
      isDefault: false,
      source: 'custom',
      skillIds: ['docx', 'web-search'],
      subagentAllowAgentIds: [],
      serverSkillIds: [],
      serverSubagentAllowAgentIds: [],
      serverImChannels: [],
    }]));
    store.dispatch(setCurrentAgentId('agent-1'));
    store.dispatch(setCurrentSession(makeSession()));

    mixworkService.clearSession({ restoreAgentSkills: true });

    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().skill.activeSkillIds).toEqual(['docx', 'web-search']);
  });

  test('does not change active skills for generic session clearing', () => {
    store.dispatch(setActiveSkillIds(['xlsx']));
    store.dispatch(setCurrentSession(makeSession()));

    mixworkService.clearSession();

    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().skill.activeSkillIds).toEqual(['xlsx']);
  });

  test('clears active skills when the current agent has no default skills', () => {
    store.dispatch(setAgents([{
      id: 'agent-1',
      name: 'Agent 1',
      description: '',
      aboutYou: '',
      icon: '',
      model: '',
      thinkingLevel: '',
      workingDirectory: '',
      enabled: true,
      pinned: false,
      pinOrder: null,
      isDefault: false,
      source: 'custom',
      skillIds: [],
      subagentAllowAgentIds: [],
      serverSkillIds: [],
      serverSubagentAllowAgentIds: [],
      serverImChannels: [],
    }]));
    store.dispatch(setCurrentAgentId('agent-1'));
    store.dispatch(setActiveSkillIds(['xlsx']));

    mixworkService.clearSession({ restoreAgentSkills: true });

    expect(store.getState().skill.activeSkillIds).toEqual([]);
  });

  test('does not restore a session whose load finishes after clearing', async () => {
    let resolveGetSession: ((value: { success: true; session: MixWorkSession }) => void) | undefined;
    const getSession = vi.fn(() => new Promise<{ success: true; session: MixWorkSession }>((resolve) => {
      resolveGetSession = resolve;
    }));
    const remoteManaged = vi.fn(async () => ({ remoteManaged: true }));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession,
          remoteManaged,
        },
      },
    });

    const pendingLoad = mixworkService.loadSession('session-1');
    mixworkService.clearSession();
    resolveGetSession?.({ success: true, session: makeSession() });
    await pendingLoad;

    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().cowork.remoteManaged).toBe(false);
    expect(remoteManaged).not.toHaveBeenCalled();
  });
});
