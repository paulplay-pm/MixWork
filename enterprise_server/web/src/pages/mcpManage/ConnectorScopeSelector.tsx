import type { JSX } from 'react';

import type { ConnectorScope } from '../../api/connectors';
import type { DeptNode } from '../../api/departments';
import type { UserRow } from '../../api/users';
import { ScopeSelector, type ScopeSelectorLabels } from '../../components/ScopeSelector';
import { t } from '../../i18n';

interface Props {
  value: ConnectorScope;
  onChange: (scope: ConnectorScope) => void;
  depts: DeptNode[];
  members: UserRow[];
  /** Report open/closed so the parent drawer can suppress its own Esc handler
   *  while the picker is up (Esc closes the picker first, then the drawer). */
  onOpenChange?: (open: boolean) => void;
}

/**
 * 授权范围 picker for the MCP connector catalog. The picker itself is shared
 * with the other catalogs (see components/ScopeSelector); only the labels
 * differ.
 */
export function ConnectorScopeSelector(p: Props): JSX.Element {
  const labels: ScopeSelectorLabels = {
    allCompany: t('mcp.scope.allCompany'),
    depts: t('mcp.scope.depts'),
    users: t('mcp.scope.users'),
    triggerEmpty: t('mcpDrawer.scope.triggerEmpty'),
    empty: t('mcpDrawer.scope.empty'),
    modalTitle: t('mcpDrawer.scope.modal.title'),
    searchDept: t('mcpDrawer.scope.modal.searchDept'),
    searchMember: t('mcpDrawer.scope.modal.searchMember'),
    deptLabel: t('mcpDrawer.scope.deptLabel'),
    members: t('mcpDrawer.scope.members'),
    memberTruncated: t('mcpDrawer.scope.memberTruncated'),
    noResult: t('mcpDrawer.scope.modal.noResult'),
    allAdded: t('mcpDrawer.scope.modal.allAdded'),
    done: t('mcpDrawer.scope.modal.done'),
  };
  return <ScopeSelector value={p.value} onChange={p.onChange} depts={p.depts} members={p.members} labels={labels} onOpenChange={p.onOpenChange} />;
}
