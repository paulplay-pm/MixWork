import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { apiClient } from '../../src/api/client';
import { useAuthStore } from '../../src/auth/store';
import { clearMeProfileCache } from '../../src/auth/useMe';
import { useToastStore } from '../../src/components/toastStore';
import { setLang } from '../../src/i18n';
import { AuditPage } from '../../src/pages/AuditPage';

const wrap = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
};

/** One row as `GET /admin/audit` returns it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  ts: '2026-10-22T06:30:45.000Z',
  user_id: 'u-1111-2222',
  user_name: '张三',
  action: 'user_disable',
  action_zh: '停用用户',
  action_en: 'Disabled user',
  tone: 'danger',
  target_type: 'user',
  target_type_zh: '用户',
  target_id: 'u-9999',
  payload: { user_id: 'u-9999', reason: 'offboard' },
  ...over,
});

const facets = {
  users: [
    { value: 'u-1111-2222', label: '张三' },
    { value: 'u-3333-4444', label: '李四' },
  ],
  actions: [
    { value: 'user_disable', label: '停用用户', label_en: 'Disabled user' },
    { value: 'login', label: '登录', label_en: 'Signed in' },
  ],
  target_types: [{ value: 'user', label: '用户', label_en: 'User' }],
};

interface ListBody {
  total: number;
  items: unknown[];
  /** The org's zone — the one the server resolved the range in and the one its
   *  CSV writes this column with. */
  timezone?: string;
  /** Matched-but-hidden rows (`?exclude=`). Defaults to 0, matching a server
   *  response where nothing is excluded. */
  excluded?: number;
}

const body = (p: ListBody) => ({
  range: '7d',
  from: '2026-10-15T16:00:00.000Z',
  to: '2026-10-22T16:00:00.000Z',
  timezone: p.timezone ?? 'Asia/Shanghai',
  page: 1,
  pageSize: 15,
  total: p.total,
  excluded: p.excluded ?? 0,
  items: p.items,
  facets,
});

const mockAudit = (p: ListBody, exportHeaders: Record<string, string> = {}): void => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/admin/audit/export.csv')) {
      return new Response('﻿统计范围：近 7 天\r\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'x-export-count': '2',
          'x-export-total': '2',
          'content-disposition': "attachment; filename*=UTF-8''7d-%E5%AE%A1%E8%AE%A1%E8%AE%B0%E5%BD%95.csv",
          ...exportHeaders,
        },
      });
    }
    // The export button gates on `audit:export` from `/me`, so the profile has
    // to be answered or the affordance never renders.
    if (url.endsWith('/me')) {
      return new Response(
        JSON.stringify({
          username: 'root',
          display_name: 'Root',
          permissions: ['audit:view', 'audit:export'],
          effectiveDataScope: 'all',
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify(body(p)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
};

const requestedUrls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));
const listUrls = (): string[] => requestedUrls().filter((u) => u.includes('/admin/audit?'));
const lastListUrl = (): string => listUrls()[listUrls().length - 1];

const columnHeaders = (): string[] =>
  Array.from(document.querySelectorAll('thead th')).map((th) => th.textContent ?? '');

/** The cell of the first row at `index`, as text.
 *
 *  Read straight off the DOM rather than through `screen`, because a facet
 *  `<option>` carries the same label a cell does — the user dropdown lists
 *  张三 and the row names 张三, and a document-wide `findByText` cannot tell
 *  which one it found. */
const cellText = (index: number): string =>
  document.querySelectorAll('tbody tr td')[index]?.textContent ?? '';

describe('pages/AuditPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    setLang('zh');
    useToastStore.setState({ toasts: [] });
    clearMeProfileCache();
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] },
    });
  });

  test('the six columns render, with the user column showing a name rather than an id', async () => {
    mockAudit({ total: 1, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    expect(columnHeaders()).toEqual(['时间', '用户', '操作', '对象类型', '对象 ID', '载荷']);
    expect(cellText(1)).toBe('张三');
    // The UUID belongs in the payload, never in the user cell.
    expect(cellText(1)).not.toContain('u-1111-2222');
    expect(cellText(4)).toBe('u-9999');
  });

  test('the time column renders YYYY/MM/DD HH:mm:ss', async () => {
    mockAudit({ total: 1, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    expect(cellText(0)).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('the time column follows the org timezone, not the browser\'s', async () => {
    // The fixture's `ts` is 06:30:45Z, which is 14:30:45 in Asia/Shanghai
    // (UTC+8) — the zone the server resolved the range in, and the one its
    // CSV writes with `formatInTimeZone(…, 'yyyy/MM/dd HH:mm:ss')`.
    mockAudit({ total: 1, items: [row()], timezone: 'Asia/Shanghai' });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    expect(cellText(0)).toBe('2026/10/22 14:30:45');
  });

  test('the same instant renders differently under a second org timezone', async () => {
    // The pair above and below is what makes the assertion discriminate: the
    // two zones sit on opposite sides of UTC, so whatever zone the suite runs
    // in, a browser-zone implementation fails at least one of them. A single
    // case passes on a machine whose zone happens to match — which is how this
    // bug hid the first time, on the usage page.
    mockAudit({ total: 1, items: [row()], timezone: 'America/New_York' });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    // 06:30:45Z is 02:30:45 in New York (EDT, UTC-4) on the same calendar day —
    // twelve hours away from the Shanghai rendering of the same instant.
    expect(cellText(0)).toBe('2026/10/22 02:30:45');
  });

  test('an unparseable timestamp renders an em dash instead of crashing the page', async () => {
    // The `ts` guard is the one the whole module exists to carry: an
    // unparseable value makes `Intl` throw inside the `try`, and without the
    // `Number.isNaN` check the `catch` retries with the browser zone and
    // throws again — this time out of the column `render`, taking the page
    // with it. Not reachable from today's server rows, so pinned here.
    mockAudit({ total: 1, items: [row({ ts: 'not-a-timestamp' })] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    expect(cellText(0)).toBe('—');
    // The row's other cells still render, so the failure is a cell, not a page.
    // Read them off the DOM rather than through `screen` — the action facet
    // `<option>` carries the same label the cell does (see `cellText`).
    expect(cellText(1)).toBe('张三');
    expect(cellText(2)).toBe('停用用户');
    expect(cellText(4)).toBe('u-9999');
  });

  test('an unparseable timestamp renders an em dash in the payload modal too', async () => {
    mockAudit({ total: 1, items: [row({ ts: 'not-a-timestamp' })] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    fireEvent.click(screen.getByRole('button', { name: '查看载荷' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('—')).toBeInTheDocument();
  });

  test('the modal shows the same timestamp as the row behind it', async () => {
    // The modal takes the row but not the zone, so a `Date` method there would
    // read the browser's and the modal would contradict its own table.
    mockAudit({ total: 1, items: [row()], timezone: 'Asia/Shanghai' });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    fireEvent.click(screen.getByRole('button', { name: '查看载荷' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('2026/10/22 14:30:45')).toBeInTheDocument();
  });

  test('an anonymous event shows an em dash in the user column', async () => {
    // A failed SSO sign-in writes no `audit_events` row, so the user is null
    // while the row still exists. Falling back to the id here would print a
    // UUID in the column the spec reserves for names.
    mockAudit({
      total: 1,
      items: [
        row({
          id: 'a2',
          user_id: null,
          user_name: null,
          action: 'login_failed',
          action_zh: '登录失败',
          tone: 'failure',
          target_type: null,
          target_type_zh: null,
          target_id: null,
          payload: null,
        }),
      ],
    });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    expect(cellText(1)).toBe('—');
    expect(cellText(3)).toBe('—');
    expect(cellText(4)).toBe('—');
    expect(cellText(5)).toBe('—');
    expect(document.body.textContent).not.toContain('u-1111-2222');
  });

  test('an unregistered action code renders as the raw code instead of blank', async () => {
    // The server's accessor falls back to `{ zh: action, en: action }`, so an
    // unknown code arrives labelled as itself rather than as an empty string.
    mockAudit({
      total: 1,
      items: [
        row({
          id: 'a3',
          action: 'sso_provider_rotate_v2',
          action_zh: 'sso_provider_rotate_v2',
          action_en: 'sso_provider_rotate_v2',
          tone: 'normal',
        }),
      ],
    });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    expect(cellText(2)).toBe('sso_provider_rotate_v2');
  });

  test('the three facet selects populate from the response facets', async () => {
    mockAudit({ total: 1, items: [row()] });
    render(wrap(<AuditPage />));
    // The selects render before the response does; wait for the first facet
    // option rather than the control itself.
    await screen.findByRole('option', { name: '张三' });
    const users = screen.getByLabelText('用户');
    const actions = screen.getByLabelText('操作');
    const types = screen.getByLabelText('对象类型');
    expect(within(users).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '全部用户',
      '张三',
      '李四',
    ]);
    expect(within(actions).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '全部操作',
      '停用用户',
      '登录',
    ]);
    expect(within(types).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '全部对象类型',
      '用户',
    ]);
  });

  test('changing any filter resets to page 1', async () => {
    mockAudit({ total: 300, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(lastListUrl()).toContain('page=2'));
    // The pager is gated on a loaded response, so it reappears after the new
    // page lands rather than showing a stale page number.
    await screen.findByText('第 2 / 20 页');

    for (const [label, value] of [
      ['用户', 'u-1111-2222'],
      ['操作', 'login'],
      ['对象类型', 'user'],
      ['对象 ID', 'u-9999'],
    ] as const) {
      fetchMock.mockClear();
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      await waitFor(() => expect(listUrls().some((u) => u.includes('page=1'))).toBe(true));
    }
  });

  test('the four filters stack and all appear in the request query string', async () => {
    mockAudit({ total: 1, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    fireEvent.change(screen.getByLabelText('用户'), { target: { value: 'u-1111-2222' } });
    fireEvent.change(screen.getByLabelText('操作'), { target: { value: 'login' } });
    fireEvent.change(screen.getByLabelText('对象类型'), { target: { value: 'user' } });
    fireEvent.change(screen.getByLabelText('对象 ID'), { target: { value: 'u-9999' } });
    await waitFor(() => {
      const q = new URL(lastListUrl(), 'http://test').searchParams;
      expect(q.get('userId')).toBe('u-1111-2222');
      expect(q.get('action')).toBe('login');
      expect(q.get('targetType')).toBe('user');
      expect(q.get('targetId')).toBe('u-9999');
    });
  });

  test('the payload modal shows formatted JSON from the already-loaded row and issues no second request', async () => {
    mockAudit({ total: 1, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    const before = listUrls().length;

    fireEvent.click(screen.getByRole('button', { name: '查看载荷' }));
    const dialog = await screen.findByRole('dialog');
    // `JSON.stringify(payload, null, 2)` — indented two spaces, verbatim.
    expect(within(dialog).getByText(/"user_id": "u-9999"/)).toBeInTheDocument();
    expect(within(dialog).getByText(/"reason": "offboard"/)).toBeInTheDocument();
    // The row was already in memory; opening the modal must not re-ask.
    expect(listUrls().length).toBe(before);
  });

  test('the modal closes on Escape and on mask click', async () => {
    mockAudit({ total: 1, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));

    fireEvent.click(screen.getByRole('button', { name: '查看载荷' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '查看载荷' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByTestId('payload-mask'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('an empty result shows the no-records message', async () => {
    mockAudit({ total: 0, items: [] });
    render(wrap(<AuditPage />));
    expect(await screen.findByText('当前筛选条件下暂无审计记录')).toBeInTheDocument();
  });

  test('the custom range reveals two date inputs', async () => {
    mockAudit({ total: 1, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    expect(document.querySelectorAll('input[type="date"]').length).toBe(0);
    fireEvent.change(screen.getByLabelText('时间范围'), { target: { value: 'custom' } });
    await waitFor(() => expect(document.querySelectorAll('input[type="date"]').length).toBe(2));
    // `from`/`to` are the only range keys that carry dates.
    expect(lastListUrl()).toContain('range=custom');
  });

  test('export toasts the count from x-export-count and names the server file', async () => {
    const createObjectURL = vi.fn(() => 'blob:audit');
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    mockAudit({ total: 2, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));

    await waitFor(() =>
      expect(requestedUrls().some((u) => u.includes('export.csv'))).toBe(true)
    );
    expect(useToastStore.getState().toasts[0]?.text).toBe('已导出 2 条（共 2 条）');
    // The name comes from `content-disposition`, not from the client.
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('7d-审计记录.csv');
    click.mockRestore();
  });

  test('a capped export says so instead of reading as complete', async () => {
    const createObjectURL = vi.fn(() => 'blob:audit');
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    mockAudit({ total: 2, items: [row()] }, { 'x-export-count': '10000', 'x-export-total': '12000' });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));

    await waitFor(() => expect(useToastStore.getState().toasts.length).toBeGreaterThan(0));
    const toast = useToastStore.getState().toasts[0];
    expect(toast?.text).toContain('10000');
    expect(toast?.text).toContain('12000');
    // Not a plain success: the file on disk is short.
    expect(toast?.kind).not.toBe('success');
    click.mockRestore();
  });

  test('the export carries the active filters and range', async () => {
    const createObjectURL = vi.fn(() => 'blob:audit');
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    mockAudit({ total: 1, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    fireEvent.change(screen.getByLabelText('用户'), { target: { value: 'u-1111-2222' } });
    fireEvent.change(screen.getByLabelText('操作'), { target: { value: 'login' } });
    await waitFor(() => expect(lastListUrl()).toContain('userId=u-1111-2222'));
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));

    await waitFor(() => {
      const exportUrl = requestedUrls().find((u) => u.includes('export.csv')) ?? '';
      expect(exportUrl).toContain('range=7d');
      expect(exportUrl).toContain('userId=u-1111-2222');
      expect(exportUrl).toContain('action=login');
      // Paging is the table's business; the file carries the whole filtered set.
      expect(exportUrl).not.toContain('page=');
    });
    click.mockRestore();
  });

  test('the page opens with model calls excluded by default', async () => {
    mockAudit({ total: 1, items: [row()], excluded: 5 });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));

    const q = new URL(lastListUrl(), 'http://test').searchParams;
    expect(q.get('exclude')).toBe('provider_call');
    expect(screen.getByRole('checkbox', { name: '隐藏模型调用' })).toBeChecked();
  });

  test('unchecking the box removes the exclusion from the next request', async () => {
    mockAudit({ total: 1, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    expect(new URL(lastListUrl(), 'http://test').searchParams.get('exclude')).toBe('provider_call');

    fireEvent.click(screen.getByRole('checkbox', { name: '隐藏模型调用' }));
    await waitFor(() => {
      const q = new URL(lastListUrl(), 'http://test').searchParams;
      expect(q.has('exclude')).toBe(false);
    });
    expect(screen.getByRole('checkbox', { name: '隐藏模型调用' })).not.toBeChecked();
  });

  test('the hidden strip discloses how many rows the default filter removed', async () => {
    mockAudit({ total: 2, items: [row()], excluded: 7 });
    render(wrap(<AuditPage />));
    expect(
      await screen.findByText('已隐藏 7 条模型调用记录；导出的 CSV 同样不包含这些记录。')
    ).toBeInTheDocument();
  });

  test('no strip renders when nothing was excluded', async () => {
    mockAudit({ total: 1, items: [row()], excluded: 0 });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    expect(document.body.textContent).not.toContain('已隐藏');
  });

  test('the export forwards the exclusion, and only while it is on', async () => {
    const createObjectURL = vi.fn(() => 'blob:audit');
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    mockAudit({ total: 1, items: [row()] });
    render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));

    // Default: the CSV and the table are the same slice.
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    await waitFor(() => {
      const exportUrl = requestedUrls().find((u) => u.includes('export.csv')) ?? '';
      expect(exportUrl).toContain('exclude=provider_call');
    });

    // Turn the filter off, and the next export matches the widened table.
    fireEvent.click(screen.getByRole('checkbox', { name: '隐藏模型调用' }));
    await waitFor(() => {
      const q = new URL(lastListUrl(), 'http://test').searchParams;
      expect(q.has('exclude')).toBe(false);
    });
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    await waitFor(() => {
      const exportUrl = requestedUrls().find((u) => u.includes('export.csv')) ?? '';
      expect(exportUrl).not.toContain('exclude=');
    });
    click.mockRestore();
  });

  test.each(['zh', 'en'] as const)('the %s page renders no untranslated chrome', async (lang) => {
    mockAudit({ total: 1, items: [row()] });
    setLang(lang);
    const { container } = render(wrap(<AuditPage />));
    await waitFor(() => expect(document.querySelectorAll('tbody tr td').length).toBe(6));
    const text = container.textContent ?? '';
    expect(text).not.toContain('No audit events.');
    expect(text).not.toContain('Export CSV  ');
  });
});

// --- Deep link from the dashboard's 最近动态 ---
describe('AuditPage — 深链参数', () => {
  const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200 });

  beforeEach(() => {
    fetchMock.mockReset();
    apiClient.setBaseUrl('http://test');
    apiClient.setTokenProvider(() => 'jwt-1');
    apiClient.setRefresh(null);
    clearMeProfileCache();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/admin/audit')) {
        return Promise.resolve(
          json({
            range: 'custom', from: '', to: '', page: 1, pageSize: 20, total: 0,
            items: [], facets: { users: [], actions: [], target_types: [] }, excluded: 0,
          })
        );
      }
      if (url.includes('/me')) {
        return Promise.resolve(json({ username: 'u1', display_name: null, permissions: [], effectiveDataScope: 'all' }));
      }
      return Promise.resolve(json({}));
    });
  });

  const renderAt = (path: string) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <AuditPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

  const auditUrl = (): URL | null => {
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/admin/audit?'));
    return call ? new URL(String(call[0])) : null;
  };

  test('?userId=&from=&to= 预置为 custom 区间并按操作人过滤', async () => {
    renderAt('/monitoring/audit?range=custom&userId=u7&from=2026-04-15&to=2026-04-15');
    await waitFor(() => expect(auditUrl()).not.toBeNull());
    const url = auditUrl()!;
    expect(url.searchParams.get('range')).toBe('custom');
    expect(url.searchParams.get('userId')).toBe('u7');
    expect(url.searchParams.get('from')).toBe('2026-04-15');
    expect(url.searchParams.get('to')).toBe('2026-04-15');
  });

  test('只有 userId 时按操作人过滤，但保留预设范围（不从 URL 取 range）', async () => {
    renderAt('/monitoring/audit?userId=u7');
    await waitFor(() => expect(auditUrl()).not.toBeNull());
    const url = auditUrl()!;
    expect(url.searchParams.get('userId')).toBe('u7');
    // `range` is deliberately NOT read from the URL: letting a link pick the
    // window is fine for `custom` (which the from/to pair already implies) but
    // not for the presets, where the dashboard and this page must agree.
    expect(url.searchParams.get('range')).not.toBe('custom');
  });

  test('无参数时保持既有默认（近 7 天、无过滤）', async () => {
    renderAt('/monitoring/audit');
    await waitFor(() => expect(auditUrl()).not.toBeNull());
    const url = auditUrl()!;
    expect(url.searchParams.get('range')).toBe('7d');
    expect(url.searchParams.get('userId')).toBeNull();
  });
});
