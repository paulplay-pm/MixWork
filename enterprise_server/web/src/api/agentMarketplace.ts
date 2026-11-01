import type { CatalogScope } from './catalogScope';
import { apiClient } from './client';

/** The agent scope IS the shared catalog scope (see catalogScope.ts): the
 *  departments (and member exceptions) the agent is visible to. */
export type AgentScope = CatalogScope;

export interface AgentMarketplaceItem {
  agentId: string;
  name: string;
  description: string;
  identity: string;
  systemPrompt: string;
  model: string;
  thinkingLevel: string;
  icon: string;
  skillIds: string[];
  subagentAllowAgentIds: string[];
  scope: AgentScope;
  enabled: boolean;
  aboutYou: string;
  iconColor: number;
  imChannels: string[];
}

export interface AgentInput {
  name: string;
  description?: string;
  identity?: string;
  system_prompt?: string;
  model?: string;
  thinking_level?: string;
  icon?: string;
  skill_ids?: string[];
  subagent_allow_agent_ids?: string[];
  scope: AgentScope;
  enabled?: boolean;
  about_you?: string;
  icon_color?: number;
  im_channels?: string[];
}

export type AgentPatch = Partial<AgentInput>;

export const agentMarketplaceApi = {
  // Public (scope-filtered) catalog — used by the agent picker on cross-references.
  listPublic: () => apiClient.get<{ agents: AgentMarketplaceItem[] }>('/api/agent-marketplace'),

  // Admin CRUD
  list: () => apiClient.get<AgentMarketplaceItem[]>('/api/admin/agent-marketplace/agents'),
  createAgent: (input: AgentInput) =>
    apiClient.post<{ agent_id: string }>('/api/admin/agent-marketplace/agents', input),
  update: (id: string, patch: AgentPatch) =>
    apiClient.put<void>(`/api/admin/agent-marketplace/agents/${id}`, patch),
  remove: (id: string) => apiClient.delete(`/api/admin/agent-marketplace/agents/${id}`),
  /** Upload the agent's icon (PNG / JPEG / WEBP / SVG, ≤ 1 MB). The stored
   *  value becomes a path this server serves; a built-in avatar is stored by
   *  the patch route instead. */
  uploadIcon: (id: string, file: File): Promise<{ icon: string }> => {
    const form = new FormData();
    form.append('icon', file, file.name);
    return apiClient.postRaw<{ icon: string }>(`/api/admin/agent-marketplace/agents/${id}/icon`, form);
  },
  clearIcon: (id: string) => apiClient.delete<{ ok: boolean }>(`/api/admin/agent-marketplace/agents/${id}/icon`),
  getReferences: (id: string) =>
    apiClient.get<{ ids: string[]; names: string[] }>(`/api/admin/agent-marketplace/agents/${id}/references`),

  // Cross-pickers (reuse the existing skill marketplace admin list)
  listSkillsForPicker: () =>
    apiClient.get<Array<{ id: string; name: string; name_zh: string | null; enabled?: boolean }>>('/api/admin/skill-marketplace/skills'),
};
