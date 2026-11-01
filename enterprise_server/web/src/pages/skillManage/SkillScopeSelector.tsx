import type { JSX } from 'react';

import type { DeptNode } from '../../api/departments';
import type { SkillScope } from '../../api/skillMarketplace';
import type { UserRow } from '../../api/users';
import { ScopeSelector, type ScopeSelectorLabels } from '../../components/ScopeSelector';
import { t } from '../../i18n';

interface Props {
  value: SkillScope;
  onChange: (scope: SkillScope) => void;
  depts: DeptNode[];
  members: UserRow[];
  /** Report open/closed so the parent drawer can suppress its own Esc handler
   *  while the picker is up (Esc closes the picker first, then the drawer). */
  onOpenChange?: (open: boolean) => void;
}

/**
 * 授权范围 picker for the skill catalog. The picker itself is shared with the
 * other catalogs (see components/ScopeSelector); only the labels differ.
 */
export function SkillScopeSelector(p: Props): JSX.Element {
  const labels: ScopeSelectorLabels = {
    allCompany: t('skillmgmt.scope.allCompany'),
    depts: t('skillmgmt.scope.depts'),
    users: t('skillmgmt.scope.users'),
    triggerEmpty: t('skillmgmt.scope.triggerEmpty'),
    empty: t('skillmgmt.scope.empty'),
    modalTitle: t('skillmgmt.scope.modal.title'),
    searchDept: t('skillmgmt.scope.modal.searchDept'),
    searchMember: t('skillmgmt.scope.modal.searchMember'),
    deptLabel: t('skillmgmt.scope.deptLabel'),
    members: t('skillmgmt.scope.members'),
    memberTruncated: t('skillmgmt.scope.memberTruncated'),
    noResult: t('skillmgmt.scope.modal.noResult'),
    allAdded: t('skillmgmt.scope.modal.allAdded'),
    done: t('skillmgmt.scope.modal.done'),
  };
  return <ScopeSelector value={p.value} onChange={p.onChange} depts={p.depts} members={p.members} labels={labels} onOpenChange={p.onOpenChange} />;
}
