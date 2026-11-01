import { enterpriseClient } from '../auth/enterpriseClient';
import type { EnterpriseModelEntry } from '../auth/enterpriseModelCache';
import { sessionStorage } from '../auth/sessionStorage';
import type { MixCWorkStore } from '../mixcworkStore';
import type { SkillManager } from '../skills/skillManager';
import { agentEnterpriseSync } from './agentEnterpriseSync';
import { agentEnterpriseSyncThrottle } from './agentEnterpriseSyncThrottle';
import type { EnterpriseAgentPrefsStore } from './enterpriseAgentPrefsStore';

/**
 * Shared "sync enterprise agents from the server" runner used by both
 * trigger (b) (app startup, inside `bootstrapMultiTenantEnterprise`) and
 * trigger (d) (after a successful enterprise login, via the
 * `setEnterpriseLoginSyncHook` body). The account key format
 * `${session.userId}@${session.orgId}` matches across triggers so the same
 * account shares one throttle window.
 */
export interface EnterpriseAgentSyncRunnerDeps {
  getMixCWorkStore: () => MixCWorkStore;
  getEnterpriseAgentPrefsStore: () => EnterpriseAgentPrefsStore;
  getSkillManager: () => SkillManager;
  getAvailableModelsRef: () => string;
  /**
   * The loaded desktop server-model list, used to translate each enterprise
   * agent's org-format model ref into the desktop ref it must be stored as
   * (`mixcwork-server/<catalog UUID>`). Includes each entry's catalog `id`.
   */
  getServerModels: () => Array<Pick<EnterpriseModelEntry, 'id' | 'provider' | 'model' | 'displayName'>>;
}

export async function runEnterpriseAgentSync(deps: EnterpriseAgentSyncRunnerDeps): Promise<void> {
  const session = sessionStorage.load();
  if (!session) return;
  const accountKey = `${session.userId}@${session.orgId}`;
  await agentEnterpriseSyncThrottle.throttledSync(accountKey, async () => {
    const serverView = await enterpriseClient.listEnterpriseAgents();
    const { report } = await agentEnterpriseSync.syncFromServer({
      serverView,
      mixcworkStore: deps.getMixCWorkStore(),
      prefsStore: deps.getEnterpriseAgentPrefsStore(),
      skillManager: deps.getSkillManager(),
      defaultModelRef: deps.getAvailableModelsRef(),
      serverModels: deps.getServerModels(),
    });
    return report;
  });
}
