import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { useAuthStore } from '../../src/auth/store';
import { DeptDetail } from '../../src/components/DeptDetail';
import { setLang } from '../../src/i18n';

const wrap = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
};

const DETAIL = {
  id: 'dept-1',
  name: 'Acme',
  code: 'ACME',
  description: null,
  path: '/Acme',
  sort: 1,
  parent_id: null,
  leader_id: null,
  breadcrumbs: [{ id: 'dept-1', name: 'Acme' }],
  canAct: true,
  stats: { direct: 1, subtree: 4, childrenCount: 1 },
  members: [],
};

/** One audit page as `GET /admin/audit` returns it.
 *
 *  `timezone` is the org's zone — the one the server resolved the range in and
 *  the one its CSV writes this column with. Overridable so a test can prove the
 *  column follows the payload rather than the browser. */
function auditPage(ids: string[], over: { timezone?: string; ts?: string } = {}) {
  return {
    range: '7d',
    from: '2026-10-15T16:00:00.000Z',
    to: '2026-10-22T16:00:00.000Z',
    timezone: over.timezone ?? 'Asia/Shanghai',
    page: 1,
    pageSize: 15,
    total: ids.length,
    items: ids.map((id, i) => ({
      id,
      ts: over.ts ?? `2026-10-2${i}T03:00:00.000Z`,
      user_id: `u${i}`,
      user_name: `Operator ${i}`,
      action: 'user_disable',
      action_zh: `停用用户 ${i}`,
      action_en: `Disabled user ${i}`,
      tone: 'danger',
      target_type: 'dept',
      target_type_zh: '部门',
      target_id: 'dept-1',
      payload: {},
    })),
    facets: { users: [], actions: [], target_types: [] },
  };
}

/** The audit tab's time cells, in document order — column 0 of each row. */
function timeCells(): string[] {
  return Array.from(document.querySelectorAll('tbody tr td:first-child')).map(
    (td) => td.textContent ?? ''
  );
}

/** The query string of the audit request, parsed. */
function auditParams(call = 0): URLSearchParams {
  const url = new URL(String(fetchMock.mock.calls[call][0]), 'http://test');
  return url.searchParams;
}

async function openAuditTab(): Promise<void> {
  render(
    wrap(
      <DeptDetail
        detail={DETAIL}
        loading={false}
        notFound={false}
        canEdit={false}
        canDelete={false}
        subs={[]}
        leaderLabel={null}
        onEdit={() => {}}
        onDelete={() => {}}
        onPickSub={() => {}}
      />
    )
  );
  await userEvent.click(await screen.findByText('操作日志'));
}

describe('components/DeptDetail audit tab', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    setLang('zh');
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] },
    });
  });

  test('asks the server for this department over an explicit range, and renders .items', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(auditPage(['a1', 'a2', 'a3'])), { status: 200 }));

    await openAuditTab();

    await waitFor(() => expect(screen.getByText('停用用户 0')).toBeInTheDocument());

    const params = auditParams();
    expect(params.get('targetType')).toBe('dept');
    expect(params.get('targetId')).toBe('dept-1');
    // An explicit range, not an implicit default: the user must be able to see
    // which window these rows cover.
    expect(params.get('range')).toBe('7d');
    // Regression guard — the org comes from the JWT, and the browser never
    // sends the `orgId` the old client passed.
    expect(params.has('orgId')).toBe(false);
    expect(params.has('from')).toBe(false);
    expect(params.has('to')).toBe(false);

    // Rows come from `.items`, so all three server rows are rendered — the old
    // client-side filter over a paged response kept at most 15.
    expect(screen.getByText('停用用户 0')).toBeInTheDocument();
    expect(screen.getByText('停用用户 1')).toBeInTheDocument();
    expect(screen.getByText('停用用户 2')).toBeInTheDocument();
    expect(screen.getByText('Operator 1')).toBeInTheDocument();
  });

  // This drawer used to render `new Date(r.ts).toLocaleString()`, which reads
  // the BROWSER's zone — so one audit event showed a different time here than
  // on `/monitoring/audit`, and than in the exported file. The response carries
  // the org's zone; the column must use it.
  //
  // The fixture's `ts` is 03:00:00Z: 11:00 in Asia/Shanghai (UTC+8), and 23:00
  // the previous day in New York (EDT, UTC-4). The pair sits on opposite sides
  // of UTC, so whatever zone the suite runs in at most one of them matches the
  // browser — which is how a browser-zone implementation fails to hide here.
  test('the time column renders in the org timezone, not the browser\'s', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(auditPage(['a1'], { timezone: 'Asia/Shanghai' })), { status: 200 })
    );
    await openAuditTab();
    await waitFor(() => expect(screen.getByText('停用用户 0')).toBeInTheDocument());
    expect(timeCells()).toEqual(['2026/10/20 11:00:00']);
  });

  test('a second org timezone renders the same instant differently', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(auditPage(['a1'], { timezone: 'America/New_York' })), { status: 200 })
    );
    await openAuditTab();
    await waitFor(() => expect(screen.getByText('停用用户 0')).toBeInTheDocument());
    expect(timeCells()).toEqual(['2026/10/19 23:00:00']);
  });

  test('an unparseable timestamp renders an em dash instead of crashing the drawer', async () => {
    // The NaN guard the shared formatter carries: without it the `catch` path
    // re-throws and the exception escapes the column `render`.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(auditPage(['a1'], { ts: 'not-a-timestamp' })), { status: 200 })
    );
    await openAuditTab();
    await waitFor(() => expect(screen.getByText('停用用户 0')).toBeInTheDocument());
    expect(timeCells()).toEqual(['—']);
    // The rest of the row still renders.
    expect(screen.getByText('Operator 0')).toBeInTheDocument();
  });

  test('shows the window and re-queries when the range changes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(auditPage(['a1'])), { status: 200 }));
    await openAuditTab();
    await waitFor(() => expect(screen.getByText('停用用户 0')).toBeInTheDocument());

    expect(screen.getByLabelText('统计范围')).toHaveValue('7d');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(auditPage(['b1'])), { status: 200 }));
    await userEvent.selectOptions(screen.getByLabelText('统计范围'), '30d');

    await waitFor(() => expect(auditParams(1).get('range')).toBe('30d'));
    // Changing the window returns to the first page; staying on page 3 of the
    // old window would show an empty table.
    expect(auditParams(1).get('page')).toBe('1');
    expect(auditParams(1).get('targetType')).toBe('dept');
    expect(auditParams(1).get('targetId')).toBe('dept-1');
  });

  test('pages with the pager', async () => {
    const page = auditPage(['a1']);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...page, total: 32 }), { status: 200 }));
    await openAuditTab();
    await waitFor(() => expect(screen.getByText('停用用户 0')).toBeInTheDocument());

    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...page, page: 2, items: page.items.map((i) => ({ ...i, action_zh: '下一页的一行' })) }), { status: 200 })
    );
    await userEvent.click(screen.getByText('下一页'));
    await waitFor(() => expect(screen.getByText('下一页的一行')).toBeInTheDocument());
    expect(auditParams(1).get('page')).toBe('2');
  });
});
