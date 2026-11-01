import type { JSX } from 'react';

import type { AgentScope } from '../../../api/agentMarketplace';
import type { DeptNode } from '../../../api/departments';
import type { UserRow } from '../../../api/users';
import { ScopeSelector, type ScopeSelectorLabels } from '../../../components/ScopeSelector';
import { t } from '../../../i18n';

interface Props {
  value: AgentScope;
  onChange: (scope: AgentScope) => void;
  depts: DeptNode[];
  members: UserRow[];
  /** Report open/closed so the parent drawer can suppress its own Esc handler
   *  while the picker is up (Esc closes the picker first, then the drawer). */
  onOpenChange?: (open: boolean) => void;
}

/**
 * 可见范围 picker for the agent catalog: the same department + member grant
 * the skill catalog uses (see components/ScopeSelector), so an admin grants an
 * agent to a department rather than to a role.
 */
export function AgentScopeSelector(p: Props): JSX.Element {
  const labels: ScopeSelectorLabels = {
    allCompany: t('agentmgmt.scope.allCompany'),
    depts: t('agentmgmt.scope.depts'),
    users: t('agentmgmt.scope.users'),
    triggerEmpty: t('agentmgmt.scope.triggerEmpty'),
    empty: t('agentmgmt.scope.empty'),
    modalTitle: t('agentmgmt.scope.modal.title'),
    searchDept: t('agentmgmt.scope.modal.searchDept'),
    searchMember: t('agentmgmt.scope.modal.searchMember'),
    deptLabel: t('agentmgmt.scope.deptLabel'),
    members: t('agentmgmt.scope.members'),
    memberTruncated: t('agentmgmt.scope.memberTruncated'),
    noResult: t('agentmgmt.scope.modal.noResult'),
    allAdded: t('agentmgmt.scope.modal.allAdded'),
    done: t('agentmgmt.scope.modal.done'),
  };
  return <ScopeSelector value={p.value} onChange={p.onChange} depts={p.depts} members={p.members} labels={labels} onOpenChange={p.onOpenChange} />;
}
