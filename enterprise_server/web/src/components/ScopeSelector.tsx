import type { JSX, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import type { CatalogScope } from '../api/catalogScope';
import type { DeptNode } from '../api/departments';
import type { UserRow } from '../api/users';
import { t } from '../i18n';

/** The authorization grant a catalog entry is visible to. It is a GRANT, never
 *  a deny: whole-company, a set of departments, and a set of members. The
 *  three are independent — a scope is a union, so picking one never takes
 *  another away. */
export type ScopeValue = CatalogScope;

/** Every user-visible string the picker needs, supplied by the caller so the
 *  component can serve several catalogs with their own i18n namespaces. */
export interface ScopeSelectorLabels {
  /** The whole-company grant (every member of the org). */
  allCompany: string;
  /** Count label for the department grant. `{n}` = number of departments. */
  depts: string;
  /** Count label for the member grant. `{m}` = number of members. */
  users: string;
  /** Trigger text when nothing is granted. */
  triggerEmpty: string;
  /** Shown in place of the chips when nothing is granted. */
  empty: string;
  /** Modal title (also the trigger's accessible name). */
  modalTitle: string;
  /** Department search placeholder. */
  searchDept: string;
  /** Member search placeholder. */
  searchMember: string;
  /** Heading of the department pane. */
  deptLabel: string;
  /** Heading of the member pane. */
  members: string;
  /** Footer note when the member list is cut off. `{n}` = total matches. */
  memberTruncated: string;
  /** Empty-state text for a search with no hits. */
  noResult: string;
  /** Empty-state text when the org has no members at all. */
  allAdded: string;
  /** Confirm button text. */
  done: string;
}

export interface ScopeSelectorProps {
  value: ScopeValue;
  onChange: (scope: ScopeValue) => void;
  depts: DeptNode[];
  members: UserRow[];
  labels: ScopeSelectorLabels;
  /** Report open/closed so the parent drawer can suppress its own Esc handler
   *  while the picker is up (Esc closes the picker first, then the drawer). */
  onOpenChange?: (open: boolean) => void;
}

/** The member list is capped so a large org cannot lock up the modal. */
const MEMBER_ROW_LIMIT = 20;

function fill(s: string, kv: Record<string, string | number>): string {
  return Object.entries(kv).reduce((a, [k, v]) => a.split(`{${k}}`).join(String(v)), s);
}

function memberName(m: UserRow): string {
  return m.display_name || m.username;
}

function Chip({
  label,
  tone,
  onRemove,
}: {
  label: string;
  tone: 'dept' | 'member';
  onRemove: () => void;
}): JSX.Element {
  const cls =
    tone === 'dept'
      ? 'bg-[var(--accent-light)] text-[var(--accent-primary)]'
      : 'bg-[#F5F3FF] text-[#7C3AED]';
  return (
    <span className={`inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[12px] ${cls}`}>
      {tone === 'member' && (
        <span aria-hidden="true">
          👤
        </span>
      )}
      {label}
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="cursor-pointer opacity-60 hover:opacity-100"
      >
        ×
      </button>
    </span>
  );
}

/**
 * 授权范围 picker. The trigger shows the current selection as chips; clicking
 * it opens a modal with a wide, independently-scrolling two-pane body:
 *  - left: a searchable department tree, with a separate 全公司 row on top;
 *  - right: a searchable member list.
 *
 * The three grants are INDEPENDENT. A scope is a union, so checking 全公司,
 * checking a department or picking a member never clears the others — the
 * admin composes the audience out of whichever pieces they want. Every
 * department in the tree is a grant in its own right: an org may have several
 * top-level departments (a `parent_id IS NULL` dept is not the company root),
 * so treating one of them as "the whole company" would tie them together.
 */
export function ScopeSelector(p: ScopeSelectorProps): JSX.Element {
  const labels = p.labels;
  const [open, setOpen] = useState(false);
  const [deptQuery, setDeptQuery] = useState('');
  const [memberQuery, setMemberQuery] = useState('');

  // id → node map over the recursive `children` tree (for chip labels).
  const deptMap = useMemo(() => {
    const map = new Map<string, DeptNode>();
    const walk = (nodes: DeptNode[]): void => {
      for (const n of nodes) {
        map.set(n.id, n);
        walk(n.children);
      }
    };
    walk(p.depts);
    return map;
  }, [p.depts]);

  // Flattened tree (with depth) so a dept search can filter across all levels.
  const flatDepts = useMemo(() => {
    const out: { node: DeptNode; depth: number }[] = [];
    const walk = (nodes: DeptNode[], depth: number): void => {
      for (const n of nodes) {
        out.push({ node: n, depth });
        walk(n.children, depth + 1);
      }
    };
    walk(p.depts, 0);
    return out;
  }, [p.depts]);

  // The trigger is a summary of the whole grant: 全公司 plus the counts of
  // the department and member grants.
  const deptCount = p.value.deptIds.length;
  const memberCount = p.value.userIds.length;
  const parts: string[] = [];
  if (p.value.allCompany) parts.push(labels.allCompany);
  if (deptCount > 0) parts.push(fill(labels.depts, { n: deptCount }));
  if (memberCount > 0) parts.push(fill(labels.users, { m: memberCount }));
  const triggerText = parts.length > 0 ? parts.join(' + ') : labels.triggerEmpty;

  const setOpenState = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setDeptQuery('');
      setMemberQuery('');
    }
    p.onOpenChange?.(next);
  };

  // Esc closes the picker (the parent drawer's Esc handler is guarded on this
  // picker's open state, so Esc closes the picker first, then the drawer).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // Claim the event so a parent drawer that also listens for Escape does
      // not close itself: this picker handles Esc first, the drawer second.
      e.preventDefault();
      setOpenState(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** The 全公司 grant. It is independent of the department and member grants:
   *  toggling it leaves both untouched. */
  const toggleAllCompany = (checked: boolean): void => {
    p.onChange({
      allCompany: checked,
      deptIds: p.value.deptIds,
      userIds: p.value.userIds,
    });
  };

  /** One department grant. Every department is independent of the others. */
  const checkDept = (id: string, checked: boolean): void => {
    const deptIds = checked
      ? [...p.value.deptIds, id]
      : p.value.deptIds.filter((d) => d !== id);
    p.onChange({ allCompany: p.value.allCompany, deptIds, userIds: p.value.userIds });
  };

  /** One member grant. Additive and independent of the department grants:
   *  clicking a selected member removes it. It never excludes — selection is
   *  always a grant. */
  const toggleMember = (id: string): void => {
    const has = p.value.userIds.includes(id);
    p.onChange({
      allCompany: p.value.allCompany,
      deptIds: p.value.deptIds,
      userIds: has ? p.value.userIds.filter((x) => x !== id) : [...p.value.userIds, id],
    });
  };

  /** The 全公司 row: a synthetic entry, not a department — it is the grant
   *  that covers every member of the org. */
  const allCompanyRow = (
    <label className="flex cursor-pointer items-center gap-2 rounded-[5px] py-1 pr-2 text-[13px] font-medium hover:bg-[var(--bg-tertiary)]">
      <input
        type="checkbox"
        className="h-3.5 w-3.5 shrink-0 accent-[var(--accent-primary)]"
        checked={p.value.allCompany}
        onChange={(e) => toggleAllCompany(e.target.checked)}
      />
      <span className="truncate">{labels.allCompany}</span>
    </label>
  );

  const deptRow = (n: DeptNode, depth: number): JSX.Element => {
    const checked = p.value.deptIds.includes(n.id);
    return (
      <label
        className="flex cursor-pointer items-center gap-2 rounded-[5px] py-1 pr-2 text-[13px] hover:bg-[var(--bg-tertiary)]"
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <input
          type="checkbox"
          className="h-3.5 w-3.5 shrink-0 accent-[var(--accent-primary)]"
          checked={checked}
          onChange={(e) => checkDept(n.id, e.target.checked)}
        />
        <span className="truncate">{n.name}</span>
      </label>
    );
  };

  const renderNested = (nodes: DeptNode[], depth: number): JSX.Element[] =>
    nodes.map((n) => (
      <div key={n.id}>
        {deptRow(n, depth)}
        {n.children.length > 0 ? renderNested(n.children, depth + 1) : null}
      </div>
    ));

  const deptQueryNorm = deptQuery.trim().toLowerCase();
  const deptMatches = deptQueryNorm
    ? flatDepts.filter((d) => d.node.name.toLowerCase().includes(deptQueryNorm))
    : flatDepts;

  const memberQueryNorm = memberQuery.trim().toLowerCase();
  const memberFiltered = p.members.filter((m) => {
    if (!memberQueryNorm) return true;
    const hay = `${memberName(m)} ${m.primary_dept_name ?? ''}`.toLowerCase();
    return hay.includes(memberQueryNorm);
  });
  const memberRows = memberFiltered.slice(0, MEMBER_ROW_LIMIT);

  const memberRow = (m: UserRow): JSX.Element => {
    const selected = p.value.userIds.includes(m.id);
    return (
      <button
        key={m.id}
        type="button"
        onClick={() => toggleMember(m.id)}
        className={`flex w-full items-center justify-between gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] transition hover:bg-[var(--bg-tertiary)] ${
          selected ? 'bg-[var(--accent-light)] text-[var(--accent-primary)]' : 'text-[var(--text-secondary)]'
        }`}
      >
        <span className="truncate">
          {memberName(m)}
          {m.primary_dept_name ? (
            <span className="text-[var(--text-tertiary)]"> · {m.primary_dept_name}</span>
          ) : null}
        </span>
        {selected ? (
          <span aria-hidden="true" className="shrink-0 font-semibold">
            ✓
          </span>
        ) : null}
      </button>
    );
  };

  const chips: ReactNode[] = [];
  if (p.value.allCompany) {
    chips.push(
      <Chip key="__all" label={labels.allCompany} tone="dept" onRemove={() => toggleAllCompany(false)} />,
    );
  }
  for (const id of p.value.deptIds) {
    const name = deptMap.get(id)?.name ?? id;
    chips.push(<Chip key={id} label={name} tone="dept" onRemove={() => checkDept(id, false)} />);
  }
  for (const uid of p.value.userIds) {
    const m = p.members.find((x) => x.id === uid);
    chips.push(
      <Chip
        key={uid}
        label={m ? memberName(m) : uid}
        tone="member"
        onRemove={() =>
          p.onChange({
            allCompany: p.value.allCompany,
            deptIds: p.value.deptIds,
            userIds: p.value.userIds.filter((x) => x !== uid),
          })
        }
      />,
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpenState(true)}
        className="flex w-full items-center justify-between rounded-[7px] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-left"
        aria-label={labels.modalTitle}
      >
        <span className="text-[13px] text-[var(--text-tertiary)]">{triggerText}</span>
        <span className="text-[var(--text-tertiary)]">▾</span>
      </button>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.length === 0 ? (
          <span className="text-[12.5px] text-[var(--text-tertiary)]">{labels.empty}</span>
        ) : (
          chips
        )}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[102] flex items-center justify-center bg-black/40"
          onClick={() => setOpenState(false)}
        >
          <div
            className="flex max-h-[86vh] w-[640px] max-w-[94vw] flex-col overflow-hidden rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-lg"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-[var(--border-default)] px-5 py-3.5">
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
                {labels.modalTitle}
              </h2>
              <button
                type="button"
                onClick={() => setOpenState(false)}
                aria-label={t('common.close')}
                className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                ✕
              </button>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-2">
              {/* Left: searchable department tree + the whole-company grant. */}
              <div className="flex min-h-0 flex-col border-r border-[var(--border-default)]">
                <div className="border-b border-[var(--border-subtle)] p-2.5">
                  <input
                    value={deptQuery}
                    onChange={(e) => setDeptQuery(e.target.value)}
                    placeholder={labels.searchDept}
                    aria-label={labels.searchDept}
                    className="w-full rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <div className="px-1 pb-1.5 text-[11.5px] font-semibold text-[var(--text-tertiary)]">
                    {labels.deptLabel}
                  </div>
                  {allCompanyRow}
                  <div className="mx-1 my-1.5 border-t border-[var(--border-subtle)]" />
                  {deptMatches.length === 0 ? (
                    <div className="px-1 py-4 text-center text-[12.5px] text-[var(--text-tertiary)]">
                      {labels.noResult}
                    </div>
                  ) : deptQueryNorm ? (
                    deptMatches.map(({ node, depth }) => (
                      <div key={node.id}>{deptRow(node, depth)}</div>
                    ))
                  ) : (
                    renderNested(p.depts, 0)
                  )}
                </div>
              </div>

              {/* Right: searchable member list (the additive 成员 grant). */}
              <div className="flex min-h-0 flex-col">
                <div className="border-b border-[var(--border-subtle)] p-2.5">
                  <input
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    placeholder={labels.searchMember}
                    aria-label={labels.searchMember}
                    className="w-full rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <div className="px-1 pb-1.5 text-[11.5px] font-semibold text-[var(--text-tertiary)]">
                    {labels.members}
                  </div>
                  {memberRows.length === 0 ? (
                    <div className="px-1 py-4 text-center text-[12.5px] text-[var(--text-tertiary)]">
                      {p.members.length === 0 ? labels.allAdded : labels.noResult}
                    </div>
                  ) : (
                    memberRows.map(memberRow)
                  )}
                </div>
                {memberFiltered.length > MEMBER_ROW_LIMIT && (
                  <div className="px-1 py-1 text-[11.5px] text-[var(--text-tertiary)]">
                    {fill(labels.memberTruncated, { n: memberFiltered.length })}
                  </div>
                )}
              </div>
            </div>

            <footer className="flex items-center justify-between gap-3 border-t border-[var(--border-default)] px-5 py-3">
              <span className="min-w-0 truncate text-[12px] text-[var(--text-tertiary)]">{triggerText}</span>
              <button
                type="button"
                onClick={() => setOpenState(false)}
                className="shrink-0 rounded-[6px] bg-[var(--accent-primary)] px-4 py-2 text-[13px] text-white hover:bg-[var(--accent-primary-hover)]"
              >
                {labels.done}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
