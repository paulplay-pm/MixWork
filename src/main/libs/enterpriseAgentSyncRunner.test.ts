import { beforeEach, describe, expect, test, vi } from 'vitest';

import { enterpriseClient } from '../auth/enterpriseClient';
import type { Session } from '../auth/sessionStorage';
import { sessionStorage } from '../auth/sessionStorage';
import { agentEnterpriseSync } from './agentEnterpriseSync';
import { agentEnterpriseSyncThrottle } from './agentEnterpriseSyncThrottle';
import { type EnterpriseAgentSyncRunnerDeps,runEnterpriseAgentSync } from './enterpriseAgentSyncRunner';

// Collaborators are imported at the top of the runner module, so mock the
// whole modules. The throttle mock delegates to `fn` so the inner sync
// actually runs (a real throttle would cache and skip it on a second call).
vi.mock('../auth/enterpriseClient', () => ({
  enterpriseClient: {
    listEnterpriseAgents: vi.fn(),
  },
}));
vi.mock('../auth/sessionStorage', () => ({
  sessionStorage: {
    load: vi.fn(),
  },
}));
vi.mock('./agentEnterpriseSync', () => ({
  agentEnterpriseSync: {
    syncFromServer: vi.fn(),
  },
}));
vi.mock('./agentEnterpriseSyncThrottle', () => ({
  agentEnterpriseSyncThrottle: {
    throttledSync: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  },
}));

type AgentView = Awaited<ReturnType<typeof enterpriseClient.listEnterpriseAgents>>[number];

function makeSession(userId: string, orgId: string): Session {
  return {
    userId,
    orgId,
    username: userId,
    displayName: userId,
    roles: [],
    jwt: 'jwt',
    expiresAt: Date.now() + 60_000,
  };
}

function makeServerView(): AgentView[] {
  return [
    {
      agentId: 'a1',
      name: 'A1',
      description: '',
      identity: '',
      aboutYou: '',
      systemPrompt: '',
      model: '',
      thinkingLevel: '',
      icon: '',
      skillIds: [],
      subagentAllowAgentIds: [],
      scope: { allCompany: false, deptIds: [], userIds: [] },
      imChannels: [],
      enabled: true,
    },
  ];
}

const mixcworkStore = { name: 'mixcworkStore' } as never;
const prefsStore = { name: 'prefsStore' } as never;
const skillManager = { name: 'skillManager' } as never;
// The loaded desktop server-model list. The runner passes it to the sync so
// an enterprise agent's org-format model ref can be stored as the desktop
// ref (`mixcwork-server/<catalog UUID>`).
const serverModels = [
  { id: 'uuid-1', provider: 'openai', model: 'gpt-4o', displayName: 'GPT-4o' },
];

function makeDeps(): EnterpriseAgentSyncRunnerDeps {
  return {
    getMixCWorkStore: () => mixcworkStore,
    getEnterpriseAgentPrefsStore: () => prefsStore,
    getSkillManager: () => skillManager,
    getAvailableModelsRef: () => 'ref-model',
    getServerModels: () => serverModels,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runEnterpriseAgentSync', () => {
  test('session present → sync runs, throttled per account, with deps values', async () => {
    vi.mocked(sessionStorage.load).mockReturnValue(makeSession('u1', 'o1'));
    const serverView = makeServerView();
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockResolvedValue(serverView);
    vi.mocked(agentEnterpriseSync.syncFromServer).mockResolvedValue({
      report: { upserted: 1, removed: 0, skipped: 0 },
    });

    await runEnterpriseAgentSync(makeDeps());

    const throttledSync = vi.mocked(agentEnterpriseSyncThrottle.throttledSync);
    expect(throttledSync).toHaveBeenCalledTimes(1);
    expect(throttledSync.mock.calls[0]?.[0]).toBe('u1@o1');

    const syncFromServer = vi.mocked(agentEnterpriseSync.syncFromServer);
    expect(syncFromServer).toHaveBeenCalledTimes(1);
    expect(syncFromServer).toHaveBeenCalledWith({
      serverView,
      mixcworkStore,
      prefsStore,
      skillManager,
      defaultModelRef: 'ref-model',
      serverModels,
    });
  });

  test('session absent → no sync', async () => {
    vi.mocked(sessionStorage.load).mockReturnValue(null);

    await runEnterpriseAgentSync(makeDeps());

    expect(agentEnterpriseSyncThrottle.throttledSync).not.toHaveBeenCalled();
    expect(agentEnterpriseSync.syncFromServer).not.toHaveBeenCalled();
    expect(enterpriseClient.listEnterpriseAgents).not.toHaveBeenCalled();
  });

  test('serverView from listEnterpriseAgents is passed through to syncFromServer', async () => {
    vi.mocked(sessionStorage.load).mockReturnValue(makeSession('u1', 'o1'));
    const serverView = makeServerView();
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockResolvedValue(serverView);
    vi.mocked(agentEnterpriseSync.syncFromServer).mockResolvedValue({
      report: { upserted: 1, removed: 0, skipped: 0 },
    });

    await runEnterpriseAgentSync(makeDeps());

    const arg = vi.mocked(agentEnterpriseSync.syncFromServer).mock.calls[0]?.[0];
    expect(arg?.serverView).toBe(serverView);
  });
});
