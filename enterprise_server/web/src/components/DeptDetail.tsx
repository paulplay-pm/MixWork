import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { formatOrgDateTime } from '../analytics/datetime';
import { rangeOptionLabel, USAGE_RANGE_KEYS, type UsageRangeKey } from '../analytics/range';
import { auditApi, type AuditListItem,badgeToneFor } from '../api/audit';
import { type DeptDetail, type DeptMember, type DeptNode } from '../api/departments';
import { useAuth } from '../auth/useAuth';
import { getLang, t } from '../i18n';
import { Badge } from './Badge';
import { type Column,DataTable } from './DataTable';
import { InfoGrid } from './InfoGrid';
import { StatsRow } from './StatsRow';
import { StatusPill } from './StatusPill';
import { Tabs } from './Tabs';

type TabKey = 'members' | 'subs' | 'audit';

/** Rows per page on the audit tab — matches the audit list's own default so
 * the department view and the audit page page identically. */
const AUDIT_PAGE_SIZE = 15;

interface Props {
  detail: DeptDetail | undefined;
  loading: boolean;
  notFound: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Sub-departments, derived from the dept tree by the page. */
  subs: DeptNode[];
  /** Leader's display name (resolved from the user list), or null. */
  leaderLabel: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onPickSub: (id: string) => void;
}

/** Empty right-pane state before a department is selected. */
export function DeptSelectHint(): JSX.Element {
  return (
    <div
      className="flex h-64 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] bg-white text-sm text-[var(--text-secondary)]"
      style={{ boxShadow: 'var(--shadow-sm)' }}
    >
      {t('dept.selectHint')}
    </div>
  );
}

export function DeptDetail({
  detail,
  loading,
  notFound,
  canEdit,
  canDelete,
  subs,
  leaderLabel,
  onEdit,
  onDelete,
  onPickSub,
}: Props): JSX.Element {
  const { claims } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<TabKey>('members');
  const [auditRange, setAuditRange] = useState<UsageRangeKey>('7d');
  const [auditPage, setAuditPage] = useState(1);
  const orgId = claims?.orgId ?? 'default-org';

  // This tab used to pull 200 rows and filter `target_type === 'dept' &&
  // target_id === id` in the browser. The audit list is paged now, so that
  // filter would have silently kept at most 15 rows — and the ones kept would
  // be the newest 15 of the ORG, most of which belong to other departments.
  // Ask the server for this department's rows instead; `targetId` exists on
  // the list endpoint for precisely this caller.
  const auditQuery = useQuery({
    queryKey: ['dept-audit', orgId, detail?.id, auditRange, auditPage],
    queryFn: () => {
      const id = detail?.id;
      // Throwing beats asking without it: a targetType-only query is a valid
      // request that answers "every department", and the user would see a
      // populated table that has nothing to do with the one they opened.
      if (!id) throw new Error('dept audit tab requires a department');
      return auditApi.list({
        range: auditRange,
        targetType: 'dept',
        targetId: id,
        page: auditPage,
        pageSize: AUDIT_PAGE_SIZE,
      });
    },
    enabled: !!detail && tab === 'audit',
  });

  if (loading) {
    return (
      <div
        className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white p-6 text-sm text-[var(--text-secondary)]"
        style={{ boxShadow: 'var(--shadow-sm)' }}
      >
        {t('common.loading')}
      </div>
    );
  }
  if (notFound || !detail) {
    return (
      <div
        className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white p-6 text-sm text-[var(--text-secondary)]"
        style={{ boxShadow: 'var(--shadow-sm)' }}
      >
        {notFound ? t('dept.notFound') : t('dept.selectHint')}
      </div>
    );
  }

  const parentName =
    detail.breadcrumbs.length > 1
      ? detail.breadcrumbs[detail.breadcrumbs.length - 2].name
      : t('dept.rootOption');

  const memberColumns: Column<DeptMember>[] = [
    {
      key: 'username',
      header: t('dept.col.username'),
      render: (r) => (
        <div className="flex flex-col">
          <span className="text-sm font-medium text-[var(--text-primary)]">{r.username}</span>
          {r.display_name && (
            <span className="text-xs text-[var(--text-tertiary)]">{r.display_name}</span>
          )}
        </div>
      ),
    },
    { key: 'email', header: t('dept.col.email'), render: (r) => r.email ?? '—' },
    { key: 'position', header: t('dept.col.position'), render: (r) => r.position ?? '—' },
    {
      key: 'extra_roles',
      header: t('dept.col.roles'),
      render: (r) =>
        r.extra_roles.length === 0 ? (
          '—'
        ) : (
          <div className="flex flex-wrap gap-1">
            {r.extra_roles.map((x) => (
              <Badge key={x} tone="neutral">
                {x}
              </Badge>
            ))}
          </div>
        ),
    },
    {
      key: 'status',
      header: t('dept.col.status'),
      render: (r) => (
        <StatusPill tone={r.status === 'active' ? 'active' : 'disabled'}>{r.status}</StatusPill>
      ),
    },
  ];

  const subColumns: Column<DeptNode>[] = [
    {
      key: 'name',
      header: t('dept.col.name'),
      render: (r) => <span className="text-sm font-medium text-[var(--text-primary)]">{r.name}</span>,
    },
    { key: 'code', header: t('dept.field.code'), render: (r) => (r.code ? <span className="font-mono text-xs">{r.code}</span> : '—') },
    { key: 'path', header: t('dept.col.path'), render: (r) => <span className="font-mono text-xs text-[var(--text-tertiary)]">{r.path}</span> },
    {
      key: 'subtreeMembers',
      header: t('dept.col.members'),
      render: (r) => (
        <Badge tone="neutral">
          <Users className="h-3 w-3" />
          {r.subtreeMembers}
        </Badge>
      ),
    },
  ];

  const auditColumns: Column<AuditListItem>[] = [
    {
      key: 'ts',
      header: t('dept.audit.col.time'),
      render: (r) => (
        // The org's zone, like every other analytics surface and like the CSV
        // this table's rows are exported into — `Date.toLocaleString()` would
        // render the browser's, so the same event would read one time here and
        // another on `/monitoring/audit`. The response carries `timezone`.
        <span className="text-xs text-[var(--text-secondary)]">
          {formatOrgDateTime(r.ts, auditQuery.data?.timezone)}
        </span>
      ),
    },
    {
      key: 'user_name',
      header: t('dept.audit.col.user'),
      render: (r) => (
        <span className="text-xs text-[var(--text-primary)]">{r.user_name ?? r.user_id ?? '—'}</span>
      ),
    },
    {
      key: 'action',
      header: t('dept.audit.col.action'),
      // Labels and tone are resolved server-side, so an unregistered action
      // code still reads as itself instead of as a blank cell.
      render: (r) => (
        <Badge tone={badgeToneFor(r.tone)}>{getLang() === 'zh' ? r.action_zh : r.action_en}</Badge>
      ),
    },
  ];

  const auditTotal = auditQuery.data?.total ?? 0;
  const auditPageCount = Math.max(1, Math.ceil(auditTotal / AUDIT_PAGE_SIZE));

  return (
    <div
      className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white p-5"
      style={{ boxShadow: 'var(--shadow-sm)' }}
    >
      {/* Header: breadcrumb, name + code, actions */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
            {detail.breadcrumbs.map((b, i) => (
              <span key={b.id} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-[var(--border-default)]">/</span>}
                <span className={i === detail.breadcrumbs.length - 1 ? 'font-medium text-[var(--text-primary)]' : ''}>
                  {b.name}
                </span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
              {detail.name}
            </h2>
            {detail.code && (
              <Badge tone="neutral">
                <span className="font-mono">{detail.code}</span>
              </Badge>
            )}
          </div>
          {detail.description && (
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{detail.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canEdit && detail.canAct && (
            <button
              onClick={onEdit}
              className="rounded-[var(--radius-md)] border border-[var(--border-default)] px-3.5 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            >
              {t('agentmgmt.edit')}
            </button>
          )}
          {canDelete && detail.canAct && (
            <button
              onClick={onDelete}
              className="rounded-[var(--radius-md)] border border-[var(--danger-primary)]/40 px-3.5 py-1.5 text-sm font-medium text-[var(--danger-primary)] hover:bg-[var(--danger-primary)]/10"
            >
              {t('common.delete')}
            </button>
          )}
        </div>
      </div>

      {/* 4 stat cards */}
      <StatsRow
        stats={[
          { label: t('dept.stat.direct'), value: detail.stats.direct },
          { label: t('dept.stat.subtree'), value: detail.stats.subtree },
          { label: t('dept.stat.children'), value: detail.stats.childrenCount },
          { label: t('dept.stat.leader'), value: leaderLabel ?? t('dept.leader.none') },
        ]}
      />

      {/* Base info */}
      <div className="mb-5">
        <h3 className="mb-2 text-[13px] font-semibold text-[var(--text-secondary)]">
          {t('dept.baseInfo')}
        </h3>
        <InfoGrid
          items={[
            { label: t('dept.field.code'), value: detail.code ?? '—' },
            { label: t('dept.col.path'), value: detail.path },
            { label: t('dept.field.parent'), value: parentName },
            { label: t('dept.field.sort'), value: String(detail.sort) },
            { label: t('dept.field.leader'), value: leaderLabel ?? t('dept.leader.none') },
          ]}
        />
      </div>

      {/* Tabs: members / sub-departments / activity */}
      <div className="mb-3 border-b border-[var(--border-subtle)]">
        <Tabs
          items={[
            { key: 'members', label: t('dept.tab.members') },
            { key: 'subs', label: t('dept.tab.subs') },
            { key: 'audit', label: t('dept.tab.audit') },
          ]}
          value={tab}
          onChange={(k) => setTab(k as TabKey)}
        />
      </div>

      {tab === 'members' && (
        <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
          <DataTable
            columns={memberColumns}
            rows={detail.members}
            emptyMessage={t('dept.membersEmpty')}
            onRowClick={(r) => nav(`/orgs/users/${r.id}`)}
          />
        </div>
      )}
      {tab === 'subs' && (
        <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
          <DataTable
            columns={subColumns}
            rows={subs}
            emptyMessage={t('dept.subsEmpty')}
            onRowClick={(r) => onPickSub(r.id)}
          />
        </div>
      )}
      {tab === 'audit' && (
        <div>
          {/* The window is part of the answer, so it is visible and editable —
              a paged list with no stated range reads as "this is everything". */}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              {t('dept.audit.range')}
              <select
                aria-label={t('dept.audit.range')}
                className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-white px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
                value={auditRange}
                onChange={(e) => {
                  setAuditRange(e.target.value as UsageRangeKey);
                  setAuditPage(1);
                }}
              >
                {USAGE_RANGE_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {rangeOptionLabel(k)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span>
                {t('dept.audit.pageInfo')
                  .replace('{page}', String(auditQuery.data?.page ?? auditPage))
                  .replace('{count}', String(auditPageCount))}
              </span>
              <button
                onClick={() => setAuditPage(auditPage - 1)}
                disabled={auditPage <= 1}
                className="rounded-[var(--radius-md)] border border-[var(--border-default)] px-2 py-1 disabled:opacity-40"
              >
                {t('dept.audit.prev')}
              </button>
              <button
                onClick={() => setAuditPage(auditPage + 1)}
                disabled={auditPage >= auditPageCount}
                className="rounded-[var(--radius-md)] border border-[var(--border-default)] px-2 py-1 disabled:opacity-40"
              >
                {t('dept.audit.next')}
              </button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
            <DataTable
              columns={auditColumns}
              rows={auditQuery.data?.items ?? []}
              loading={auditQuery.isLoading}
              emptyMessage={t('dept.auditEmpty')}
              rowKey={(r) => r.id}
            />
          </div>
        </div>
      )}
    </div>
  );
}
