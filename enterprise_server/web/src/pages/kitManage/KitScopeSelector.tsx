import type { JSX } from 'react';

import type { DeptNode } from '../../api/departments';
import type { KitScope } from '../../api/kitCatalog';
import type { UserRow } from '../../api/users';
import { ScopeSelector, type ScopeSelectorLabels } from '../../components/ScopeSelector';
import { t } from '../../i18n';

interface Props {
  value: KitScope;
  onChange: (scope: KitScope) => void;
  depts: DeptNode[];
  members: UserRow[];
  /** Report open/closed so the parent drawer can suppress its own Esc handler
   *  while the picker is up (Esc closes the picker first, then the drawer). */
  onOpenChange?: (open: boolean) => void;
}

/**
 * 授权范围 picker for the kit catalog. The picker itself is shared with the
 * other catalogs (see components/ScopeSelector); only the labels differ.
 */
export function KitScopeSelector(p: Props): JSX.Element {
  const labels: ScopeSelectorLabels = {
    allCompany: t('kitmgmt.scope.allCompany'),
    depts: t('kitmgmt.scope.depts'),
    users: t('kitmgmt.scope.users'),
    triggerEmpty: t('kitmgmt.scope.triggerEmpty'),
    empty: t('kitmgmt.scope.empty'),
    modalTitle: t('kitmgmt.scope.modal.title'),
    searchDept: t('kitmgmt.scope.modal.searchDept'),
    searchMember: t('kitmgmt.scope.modal.searchMember'),
    deptLabel: t('kitmgmt.scope.deptLabel'),
    members: t('kitmgmt.scope.members'),
    memberTruncated: t('kitmgmt.scope.memberTruncated'),
    noResult: t('kitmgmt.scope.modal.noResult'),
    allAdded: t('kitmgmt.scope.modal.allAdded'),
    done: t('kitmgmt.scope.modal.done'),
  };
  return <ScopeSelector value={p.value} onChange={p.onChange} depts={p.depts} members={p.members} labels={labels} onOpenChange={p.onOpenChange} />;
}
