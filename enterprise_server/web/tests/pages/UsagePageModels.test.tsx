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
import { UsagePage } from '../../src/pages/UsagePage';

const wrap = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
};

interface Payload {
  total: number;
  unaccounted_calls: number;
  items: unknown[];
}

const payload = (over: Partial<Payload> = {}): Payload => ({
  total: 2,
  unaccounted_calls: 0,
  items: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      display_name: 'Claude Sonnet 5',
      total_tokens: 12345,
      call_count: 12,
    },
    {
      provider: 'openai',
      model: 'gpt-5',
      display_name: 'GPT-5',
      total_tokens: 6789,
      call_count: 3,
    },
  ],
  ...over,
});

const body = (p: Payload) => ({
  range: '7d',
  from: '2026-10-15T16:00:00.000Z',
  to: '2026-10-22T16:00:00.000Z',
  timezone: 'Asia/Shanghai',
  page: 1,
  pageSize: 50,
  ...p,
});

const mockUsage = (p: Payload): void => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/admin/usage/export.csv')) {
      return new Response('﻿统计范围：近 7 天\r\n', {
        status: 200,
        headers: { 'content-type': 'text/csv', 'x-export-count': String(p.total) },
      });
    }
    // The export button gates on `usage:export` from `/me`, so the profile has
    // to be answered or the affordance never renders.
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
    // The page opens on the member tab, so the users query runs first and must
    // get a member-shaped row — the catch-all below used to answer it with a
    // model row, which has no `user_id` for the avatar key.
    if (url.includes('/admin/usage/users')) {
      return new Response(
        JSON.stringify({
          ...body({ total: 1, unaccounted_calls: 0, items: [] }),
          items: [
            {
              user_id: 'u1',
              username: 'zhangwei',
              display_name: '张伟',
              department_name: '研发中心',
              total_tokens: 0,
              last_used_at: null,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(body(p)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
};

const requestedUrls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));

/** Render the page and switch to the model tab. The page now lands on 用户用量 by
 *  default, so a test that means to exercise the model table has to say so. */
const openModelsTab = async (): Promise<void> => {
  render(wrap(<UsagePage />));
  fireEvent.click(await screen.findByRole('button', { name: '模型用量' }));
  await screen.findByText('anthropic');
};

describe('pages/UsagePage (models tab)', () => {
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

  test('the range picker offers the five preset windows', async () => {
    mockUsage(payload());
    await openModelsTab();
    const select = await screen.findByRole('combobox');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '今天',
      '近 7 天',
      '近 30 天',
      '本月',
      '上月',
    ]);
  });

  test('the models table shows provider, model name, tokens and call count', async () => {
    mockUsage(payload());
    await openModelsTab();
    expect(await screen.findByText('anthropic')).toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 5')).toBeInTheDocument();
    expect(screen.getByText('GPT-5')).toBeInTheDocument();
    expect(screen.getByText((12345).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText((6789).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText(String(12))).toBeInTheDocument();
    expect(screen.getByText(String(3))).toBeInTheDocument();
  });

  test('the footer count comes from the response total, so it agrees with the CSV', async () => {
    mockUsage(payload({ total: 2 }));
    await openModelsTab();
    expect(await screen.findByText('共 2 个模型 · 统计范围：近 7 天')).toBeInTheDocument();
  });

  test('a paged response counts the whole result set, not the rows on screen', async () => {
    // Two rows rendered, but the server says 412 match — the footer must say 412.
    mockUsage(payload({ total: 412 }));
    await openModelsTab();
    expect(await screen.findByText('共 412 个模型 · 统计范围：近 7 天')).toBeInTheDocument();
  });

  test('switching the range refetches the models for the new window from page 1', async () => {
    mockUsage(payload({ total: 412 }));
    await openModelsTab();
    await screen.findByText('anthropic');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() =>
      expect(requestedUrls().some((u) => u.includes('page=2'))).toBe(true)
    );

    fetchMock.mockClear();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '30d' } });
    await waitFor(() => {
      const modelsCalls = requestedUrls().filter((u) => u.includes('/admin/usage/models'));
      expect(modelsCalls.length).toBeGreaterThan(0);
      expect(modelsCalls.every((u) => u.includes('range=30d') && u.includes('page=1'))).toBe(true);
    });
  });

  test('the pager disables previous on page 1 and next on the last page', async () => {
    mockUsage(payload({ total: 60 }));
    await openModelsTab();
    // 60 rows over 50-row pages: two pages.
    expect(await screen.findByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled());
    expect(screen.getByRole('button', { name: '上一页' })).not.toBeDisabled();
  });

  test('unaccounted calls render the gap notice', async () => {
    mockUsage(payload({ unaccounted_calls: 37 }));
    await openModelsTab();
    expect(
      await screen.findByText('本周期内 37 次调用未能取得 token 统计，实际用量可能偏低')
    ).toBeInTheDocument();
  });

  test('no gap notice when every call reported tokens', async () => {
    mockUsage(payload({ unaccounted_calls: 0 }));
    await openModelsTab();
    await screen.findByText('anthropic');
    expect(
      screen.queryByText(/未能取得 token 统计/)
    ).not.toBeInTheDocument();
  });

  test('the export button downloads the CSV for the current range and reports its row count', async () => {
    const createObjectURL = vi.fn(() => 'blob:usage');
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    mockUsage(payload({ total: 412 }));
    await openModelsTab();
    await screen.findByText('anthropic');
    fireEvent.click(screen.getByRole('button', { name: /导出用量/ }));

    await waitFor(() =>
      expect(
        requestedUrls().some((u) => u.includes('export.csv') && u.includes('range=7d'))
      ).toBe(true)
    );
    // The toast quotes the CSV's own `x-export-count`, not the page's row count.
    expect(useToastStore.getState().toasts[0]?.text).toBe('已导出 412 条用量记录（近 7 天）');
    expect(createObjectURL).toHaveBeenCalled();
    click.mockRestore();
  });

  test.each(['zh', 'en'] as const)(
    'the %s page carries no quota, limit or usage-rate vocabulary',
    async (lang) => {
      mockUsage(payload({ unaccounted_calls: 37 }));
      setLang(lang);
      const { container } = render(wrap(<UsagePage />));
      // The tab label is itself translated, so it cannot be hardcoded here.
      fireEvent.click(
        await screen.findByRole('button', {
          name: lang === 'zh' ? '模型用量' : 'Model usage',
        }),
      );
      await screen.findByText('Claude Sonnet 5');
      const text = container.textContent ?? '';
      expect(text).not.toMatch(/配额|限额|额度|使用率|quota|limit|usage[- ]rate/i);
    }
  );
});

// --- Deep links from the dashboard ---
describe('UsagePage — 深链参数', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Absolute base so `new URL(call)` can parse the recorded request.
    apiClient.setBaseUrl('http://test');
    apiClient.setTokenProvider(() => 'jwt-1');
    apiClient.setRefresh(null);
    useToastStore.setState({ toasts: [] });
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] },
    } as never);
    clearMeProfileCache();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/admin/usage/models')) {
        return Promise.resolve(
          json({
            range: '30d', items: [
              { provider: 'anthropic', model: 'opus', display_name: 'Claude Opus', total_tokens: 5, call_count: 1 },
            ],
          })
        );
      }
      if (url.includes('/me')) {
        return Promise.resolve(json({ username: 'u1', display_name: null, permissions: [], effectiveDataScope: 'all' }));
      }
      return Promise.resolve(json({}));
    });
  });

  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200 });

  /** The range the page actually put on the wire, from whichever usage
   *  endpoint it called (the models one is disabled on the members tab). */
  const rangeOnWire = (): string | null => {
    const call = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes('/admin/usage/') && !String(c[0]).includes('/users/')
    ) ?? fetchMock.mock.calls.find((c) => String(c[0]).includes('/admin/usage/'));
    if (!call) return null;
    return new URL(String(call[0])).searchParams.get('range');
  };

  const renderAt = (path: string) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <UsagePage />
        </MemoryRouter>
      </QueryClientProvider>
    );

  test('?range=30d 初始化为近 30 天而不是默认的 7d', async () => {
    renderAt('/monitoring/usage?range=30d');
    await waitFor(() => expect(rangeOnWire()).toBe('30d'));
  });

  test('?range= 非法时回落到 7d 而不是抛错', async () => {
    renderAt('/monitoring/usage?range=nonsense');
    await waitFor(() => expect(rangeOnWire()).toBe('7d'));
  });

  test('?model=provider/model 带上该过滤请求，并切到模型 tab', async () => {
    renderAt('/monitoring/usage?range=30d&model=anthropic%2Fopus');
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/admin/usage/models'));
      expect(new URL(String(call![0])).searchParams.get('model')).toBe('anthropic/opus');
    });
    // The models query is `enabled: tab === Models`, so the request firing at
    // all proves the deep link switched tabs rather than leaving the user on
    // the members tab with a filter nobody applied.
    expect(await screen.findByText('Claude Opus')).toBeInTheDocument();
  });

  test('无 ?model 时默认仍停在用户 tab', async () => {
    renderAt('/monitoring/usage');
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/admin/usage/users'));
      expect(call).toBeDefined();
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/admin/usage/models'))).toBe(false);
  });
});
