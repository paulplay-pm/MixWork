import type { AgentInput, AgentMarketplaceItem, AgentScope } from '../../../api/agentMarketplace';

export interface AgentDraft {
  agentId: string | null;
  name: string; description: string; icon: string; iconColor: number;
  model: string; thinkingLevel: string; enabled: boolean;
  identity: string; systemPrompt: string; aboutYou: string;
  skillIds: string[]; subagentAllowAgentIds: string[]; scope: AgentScope;
  imChannels: string[];
}

const emptyScope = (): AgentScope => ({ allCompany: false, deptIds: [], userIds: [] });

export function emptyDraft(): AgentDraft {
  // No default grant: a new agent is only visible once the admin explicitly
  // picks a scope in the 可见范围 tab (validateDraft enforces it).
  return { agentId: null, name: '', description: '', icon: 'bot', iconColor: 0,
    model: '', thinkingLevel: 'medium', enabled: true, identity: '', systemPrompt: '',
    aboutYou: '', skillIds: [], subagentAllowAgentIds: [], scope: emptyScope(), imChannels: [] };
}

export function draftFromAgent(a: AgentMarketplaceItem): AgentDraft {
  return { agentId: a.agentId, name: a.name, description: a.description, icon: a.icon,
    iconColor: a.iconColor, model: a.model, thinkingLevel: a.thinkingLevel || 'medium',
    enabled: a.enabled, identity: a.identity, systemPrompt: a.systemPrompt, aboutYou: a.aboutYou,
    skillIds: [...a.skillIds], subagentAllowAgentIds: [...a.subagentAllowAgentIds],
    scope: { allCompany: a.scope?.allCompany ?? false,
      deptIds: [...(a.scope?.deptIds ?? [])], userIds: [...(a.scope?.userIds ?? [])] },
    imChannels: [...(a.imChannels ?? [])] };
}

export function isDirty(d: AgentDraft, initial: AgentDraft): boolean {
  if (d.agentId === null) return JSON.stringify(d) !== JSON.stringify(emptyDraft());
  return JSON.stringify(d) !== JSON.stringify(initial);
}

/** A scope that grants nothing: no company-wide grant, no department, no
 *  member. Such an agent is invisible to everybody but a super admin. */
export function isEmptyScope(scope: AgentScope): boolean {
  return !scope.allCompany && scope.deptIds.length === 0 && scope.userIds.length === 0;
}

export function validateDraft(d: AgentDraft): { name?: string; scope?: string } {
  const errs: { name?: string; scope?: string } = {};
  if (!d.name.trim()) errs.name = 'name';
  if (isEmptyScope(d.scope)) errs.scope = 'scope';
  return errs;
}

export function draftToInput(d: AgentDraft): AgentInput {
  return { name: d.name.trim(), description: d.description, identity: d.identity,
    system_prompt: d.systemPrompt, model: d.model, thinking_level: d.thinkingLevel,
    icon: d.icon, icon_color: d.iconColor, about_you: d.aboutYou,
    skill_ids: d.skillIds, subagent_allow_agent_ids: d.subagentAllowAgentIds,
    scope: d.scope, enabled: d.enabled, im_channels: d.imChannels };
}
