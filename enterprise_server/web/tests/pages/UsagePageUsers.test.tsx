/**
 * The member tab, the drawer and the two hand-rolled SVG charts.
 *
 * The load-bearing cases are the two the spec calls out by name: the daily
 * chart keeps a slot for every day in the range (so its bar count equals the
 * range length, never a locally computed day count), and a member with no
 * calls gets a sentence in each chart section rather than an empty axis.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { useAuthStore } from '../../src/auth/store';
import { clearMeProfileCache } from '../../src/auth/useMe';
import { useToastStore } from '../../src/components/toastStore';
import { setLang } from '../../src/i18n';
import { UsagePage } from '../../src/pages/UsagePage';

const wrap = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
};

interface UserRow {
  user_id: string;
  username: string;
  display_name: string | null;
  department_name: string | null;
  total_tokens: number;
  last_used_at: string | null;
}

interface DetailPayload {
  daily: { date: string; tokens: number }[];
  by_model: { provider: string; model: string; display_name: string; tokens: number; pct: number }[];
  unaccounted_calls: number;
}

/** Seven days, five with usage — `today` and two others are zero. */
const week = (): DetailPayload => ({
  daily: [
    { date: '2026-10-15', tokens: 0 },
    { date: '2026-10-16', tokens: 8123 },
    { date: '2026-10-17', tokens: 400 },
    { date: '2026-10-18', tokens: 0 },
    { date: '2026-10-19', tokens: 22 },
    { date: '2026-10-20', tokens: 91000 },
    { date: '2026-10-21', tokens: 0 },
  ],
  by_model: [
    { provider: 'anthropic', model: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', tokens: 90000, pct: 90.4 },
    { provider: 'openai', model: 'gpt-5', display_name: 'GPT-5', tokens: 9545, pct: 9.6 },
  ],
  unaccounted_calls: 0,
});

const detail = (userId: string, over: Partial<DetailPayload> = {}): Record<string, unknown> => ({
  range: '7d',
  from: '2026-10-15T16:00:00.000Z',
  to: '2026-10-22T16:00:00.000Z',
  timezone: 'Asia/Shanghai',
  user: {
    user_id: userId,
    display_name: userId === 'u1' ? '张伟' : null,
    department_name: userId === 'u1' ? '研发中心' : null,
  },
  ...week(),
  ...over,
});

/** `timezone` is the org's zone — the one the server resolved the range in and
 *  the one it writes `last_used_at` into the CSV with. Overridable so a test
 *  can prove the table follows the payload rather than the browser. */
const roster = (over: { total?: number; items?: UserRow[]; timezone?: string } = {}): Record<
  string,
  unknown
> => ({
  range: '7d',
  from: '2026-10-15T16:00:00.000Z',
  to: '2026-10-22T16:00:00.000Z',
  timezone: over.timezone ?? 'Asia/Shanghai',
  page: 1,
  pageSize: 8,
  unaccounted_calls: 0,
  total: over.total ?? 2,
  items: over.items ?? [
    {
      user_id: 'u1',
      username: 'zhangwei',
      display_name: '张伟',
      department_name: '研发中心',
      total_tokens: 99545,
      last_used_at: '2026-10-21T14:23:11.000Z',
    },
    // Zero usage in range: the roster lists it (D6) and the em dash marks it.
    {
      user_id: 'u2',
      username: 'lisi',
      display_name: null,
      department_name: null,
      total_tokens: 0,
      last_used_at: null,
    },
  ],
});

const modelsPayload: Record<string, unknown> = {
  range: '7d',
  from: '2026-10-15T16:00:00.000Z',
  to: '2026-10-22T16:00:00.000Z',
  timezone: 'Asia/Shanghai',
  page: 1,
  pageSize: 50,
  total: 1,
  unaccounted_calls: 0,
  items: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      display_name: 'Claude Sonnet 5',
      total_tokens: 12345,
      call_count: 12,
    },
  ],
};

const mockUsage = (
  users: Record<string, unknown> = roster(),
  detailOver: Partial<DetailPayload> = {},
  userId = 'u1',
  permissions: string[] = ['usage:view', 'usage:export']
): void => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/admin/usage/export.csv')) {
      return new Response('﻿统计范围：近 7 天\r\n', {
        status: 200,
        headers: { 'content-type': 'text/csv', 'x-export-count': '1' },
      });
    }
    // The export button gates on `usage:export` from `/me`; without this the
    // affordance never renders. Matched before the usage routes so a URL that
    // merely contains "/me" cannot be swallowed by them.
    if (url.endsWith('/me')) {
      return json({ username: 'root', display_name: 'Root', permissions, effectiveDataScope: 'all' });
    }
    if (url.includes('/admin/usage/models')) return json(modelsPayload);
    // `/users/<id>` must be matched before `/users`, or the list response
    // answers the drawer.
    if (url.includes('/admin/usage/users/')) return json(detail(userId, detailOver));
    if (url.includes('/admin/usage/users')) return json(users);
    throw new Error(`unexpected fetch ${url}`);
  });
};

const requestedUrls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));
const userCalls = (): string[] => requestedUrls().filter((u) => u.includes('/admin/usage/users?'));

/** Render the page and wait for the member toolbar and roster. The page lands on
 *  用户用量 by default, so there is no tab to switch to — waiting on the models
 *  table instead (as this helper used to) would hang forever. */
const openUsersTab = async (): Promise<void> => {
  render(wrap(<UsagePage />));
  await screen.findByRole('searchbox', { name: '搜索成员' });
  await screen.findAllByRole('button', { name: '查看明细' });
};

/** The member row's last-used cell, located by its column rather than by a
 *  text match — the em dash appears in the department column too. */
const lastUsedOf = (name: string): string => {
  const row = screen.getByText(name).closest('tr') as HTMLElement;
  return within(row.getElementsByTagName('td')[3]).getByTestId('user-last-used').textContent ?? '';
};

describe('pages/UsagePage (users tab)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    setLang('zh');
    useToastStore.setState({ toasts: [] });
    // The /me profile is cached per session token, so a stale one from a
    // previous test would answer the next one's permission gate.
    clearMeProfileCache();
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] },
    });
  });

  test('the member list renders a row for a member with zero usage and an em dash for last used', async () => {
    mockUsage();
    await openUsersTab();

    // `display_name` falls back to `username` when the member has no name.
    expect(await screen.findByText('张伟')).toBeInTheDocument();
    // The zero-usage member is on the roster (D6) and reads 「—」, not blank.
    expect(screen.getByText('lisi')).toBeInTheDocument();
    expect(lastUsedOf('lisi')).toBe('—');
    // 14:23:11Z is 22:23 in Asia/Shanghai — the org's zone, which is what the
    // CSV uses for this column.
    expect(lastUsedOf('张伟')).toBe('10/21 22:23');
  });

  test('the last-used column follows the response timezone, not the browser\'s', async () => {
    // Two org zones with opposite offsets from UTC. Whatever zone the suite
    // happens to run in, at most one of these matches it — so between them
    // they fail if the column ever falls back to the browser's zone again.
    mockUsage(roster({ timezone: 'Asia/Shanghai' }));
    await openUsersTab();
    expect(await screen.findByText('张伟')).toBeInTheDocument();
    expect(lastUsedOf('张伟')).toBe('10/21 22:23');
  });

  test('an unparseable last_used_at renders an em dash instead of crashing the page', async () => {
    // The NaN guard has to be in the shared formatter, not at one call site:
    // an unparseable value makes `Intl` throw inside the `try`, and without
    // the check the `catch` retries with the browser zone and throws AGAIN —
    // this time out of the column `render`, into a page crash. Not reachable
    // from today's server rows, so pinned here.
    mockUsage(
      roster({
        total: 2,
        items: [
          {
            user_id: 'u1',
            username: 'zhangwei',
            display_name: '张伟',
            department_name: '研发中心',
            total_tokens: 99545,
            last_used_at: 'not-a-timestamp',
          },
          {
            user_id: 'u2',
            username: 'lisi',
            display_name: '李四',
            department_name: null,
            total_tokens: 12,
            last_used_at: '2026-10-21T14:23:11.000Z',
          },
        ],
      })
    );
    await openUsersTab();
    await screen.findByText('张伟');

    expect(lastUsedOf('张伟')).toBe('—');
    // The rest of the row, and the rest of the table, still render — the
    // failure is one cell, not the page.
    expect(lastUsedOf('李四')).toBe('10/21 22:23');
    expect(screen.getByText('共 2 名成员 · 统计范围：近 7 天')).toBeInTheDocument();
  });

  test('a second org zone renders the same instant differently', async () => {
    mockUsage(roster({ timezone: 'America/New_York' }));
    await openUsersTab();
    expect(await screen.findByText('张伟')).toBeInTheDocument();
    // 14:23Z is 10:23 in New York (EDT, UTC-4).
    expect(lastUsedOf('张伟')).toBe('10/21 10:23');
  });

  test('search sends the q parameter and resets to page 1', async () => {
    mockUsage(roster({ total: 20 }));
    await openUsersTab();

    // Page to 2 first, so a search that forgot to reset would show `page=2`.
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(userCalls().some((u) => u.includes('page=2'))).toBe(true));

    fetchMock.mockClear();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索成员' }), { target: { value: 'zhang' } });
    await waitFor(() => {
      const calls = userCalls();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((u) => u.includes('q=zhang') && u.includes('page=1'))).toBe(true);
    });
  });

  test('the previous button is disabled on page 1 and next on the last page', async () => {
    // 20 members over 8-row pages: three pages.
    mockUsage(roster({ total: 20 }));
    await openUsersTab();

    expect(await screen.findByText('共 20 名成员 · 统计范围：近 7 天')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '上一页' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(screen.getByText('第 3 / 3 页')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一页' })).not.toBeDisabled();
  });

  test('changing the range closes an open drawer', async () => {
    mockUsage();
    await openUsersTab();
    fireEvent.click((await screen.findAllByRole('button', { name: '查看明细' }))[0]);
    await screen.findByTestId('usage-drawer');
    await screen.findAllByTestId('daily-slot');

    fireEvent.change(screen.getByRole('combobox', { name: '时间范围' }), {
      target: { value: '30d' },
    });
    await waitFor(() => expect(screen.queryByTestId('usage-drawer')).not.toBeInTheDocument());
  });

  test('the drawer shows one bar slot per day in the range and draws no bar for a zero day', async () => {
    mockUsage();
    await openUsersTab();
    fireEvent.click((await screen.findAllByRole('button', { name: '查看明细' }))[0]);
    await screen.findAllByTestId('daily-slot');

    // The server already sends one entry per day, zero days included, so the
    // slot count is the array length — never a locally computed day count.
    const slots = screen.getAllByTestId('daily-slot');
    expect(slots).toHaveLength(week().daily.length);
    // Three of the seven days are zero: the slot stays, the rect does not.
    expect(screen.getAllByTestId('daily-bar')).toHaveLength(4);
    expect(slots.map((s) => s.getAttribute('data-tokens'))).toEqual(
      week().daily.map((d) => String(d.tokens))
    );
  });

  test('a member with no calls shows both empty states, not a bare axis', async () => {
    const silent: Partial<DetailPayload> = {
      daily: [
        { date: '2026-10-15', tokens: 0 },
        { date: '2026-10-16', tokens: 0 },
        { date: '2026-10-17', tokens: 0 },
        { date: '2026-10-18', tokens: 0 },
        { date: '2026-10-19', tokens: 0 },
        { date: '2026-10-20', tokens: 0 },
        { date: '2026-10-21', tokens: 0 },
      ],
      by_model: [],
    };
    mockUsage(roster(), silent);
    await openUsersTab();
    fireEvent.click((await screen.findAllByRole('button', { name: '查看明细' }))[1]);
    // Wait for the sections, not just the shell: the drawer paints before its
    // detail query lands.
    await screen.findByTestId('drawer-daily');

    expect(within(screen.getByTestId('drawer-daily')).getByTestId('chart-empty')).toBeInTheDocument();
    expect(within(screen.getByTestId('drawer-models')).getByTestId('chart-empty')).toBeInTheDocument();
    // An empty coordinate system is the failure this replaces.
    expect(screen.queryByTestId('daily-slot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('daily-bar')).not.toBeInTheDocument();
  });

  test('the drawer closes on Escape and on mask click', async () => {
    mockUsage();
    await openUsersTab();

    const open = async (): Promise<void> => {
      fireEvent.click((await screen.findAllByRole('button', { name: '查看明细' }))[0]);
      await screen.findByTestId('usage-drawer');
    };

    await open();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('usage-drawer')).not.toBeInTheDocument());

    await open();
    fireEvent.click(screen.getByTestId('drawer-mask'));
    await waitFor(() => expect(screen.queryByTestId('usage-drawer')).not.toBeInTheDocument());
  });

  test.each(['zh', 'en'] as const)(
    'the %s member tab and drawer carry no quota, limit or usage-rate vocabulary',
    async (lang) => {
      mockUsage();
      setLang(lang);
      const { container } = render(wrap(<UsagePage />));
      // The page opens on the member tab, so there is nothing to switch to.
      await screen.findByRole('searchbox', { name: lang === 'zh' ? '搜索成员' : 'Search members' });
      fireEvent.click((await screen.findAllByRole('button', { name: /查看明细|View details/ }))[0]);
      await screen.findAllByTestId('daily-slot');

      const text = container.textContent ?? '';
      expect(text).not.toMatch(/配额|限额|额度|使用率|quota|limit|usage[- ]rate/i);
    }
  );

  test('the members usage column is captioned 用量, not the model tab\'s 模型用量(tokens)', async () => {
    mockUsage();
    await openUsersTab();
    await screen.findByText('张伟');
    // `col.tokens` on a member row would name a different metric.
    expect(screen.getByRole('columnheader', { name: '用量(tokens)' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '模型用量(tokens)' })).not.toBeInTheDocument();
  });

  test('the export button is hidden without usage:export rather than left failing', async () => {
    mockUsage(roster(), {}, 'u1', ['usage:view']);
    render(wrap(<UsagePage />));
    await screen.findByRole('searchbox', { name: '搜索成员' });
    expect(screen.queryByRole('button', { name: /导出用量/ })).not.toBeInTheDocument();
  });

  test('the export button downloads under the name content-disposition asks for', async () => {
    const createObjectURL = vi.fn(() => 'blob:usage');
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    // The anchor is created, populated and clicked, so `download` has to be
    // read off the element the page handed to the DOM. Call through to the
    // real method — React Testing Library mounts its container the same way,
    // and swallowing that would render nothing at all.
    const realAppend = document.body.appendChild.bind(document.body);
    let downloaded: string | null = null;
    vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLAnchorElement) downloaded = node.download;
      return realAppend(node);
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('/admin/usage/export.csv')) {
        // Exactly what `csvResponse` emits for the members tab.
        return new Response('﻿统计范围：近 7 天\r\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': "attachment; filename*=UTF-8''7d-%E7%94%A8%E6%88%B7%E7%94%A8%E9%87%8F.csv",
            'x-export-count': '2',
          },
        });
      }
      if (url.endsWith('/me')) {
        return json({
          username: 'root',
          display_name: 'Root',
          permissions: ['usage:view', 'usage:export'],
          effectiveDataScope: 'all',
        });
      }
      if (url.includes('/admin/usage/models')) return json(modelsPayload);
      if (url.includes('/admin/usage/users/')) return json(detail('u1'));
      if (url.includes('/admin/usage/users')) return json(roster());
      throw new Error(`unexpected fetch ${url}`);
    });

    render(wrap(<UsagePage />));
    await screen.findByText('张伟');
    fireEvent.click(screen.getByRole('button', { name: /导出用量/ }));

    await waitFor(() => {
      const csv = requestedUrls().filter((u) => u.includes('export.csv'));
      expect(csv.length).toBe(1);
      // The members tab's export carries the tab and its filters.
      expect(csv[0]).toContain('tab=users');
    });
    expect(useToastStore.getState().toasts[0]?.text).toBe('已导出 2 条用量记录（近 7 天）');
    // The server's own name, percent-decoded: the range key makes an archived
    // file self-describing.
    expect(downloaded).toBe('7d-用户用量.csv');
  });

  test('a failed list fetch shows the error state, not an empty table', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return new Response(
          JSON.stringify({
            username: 'root',
            display_name: 'Root',
            permissions: ['usage:view', 'usage:export'],
            effectiveDataScope: 'all',
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    });
    render(wrap(<UsagePage />));
    expect(await screen.findByText('出错了')).toBeInTheDocument();
    // "No usage recorded" would be a claim about the org's data, and we
    // failed to fetch it.
    expect(screen.queryByText('该周期内没有用量记录')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pager-summary')).not.toBeInTheDocument();
  });
});