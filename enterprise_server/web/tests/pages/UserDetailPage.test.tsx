// Pin the runtime zone before anything formats a date, so the asserted
// timestamp text is deterministic on a developer machine that is not on UTC.
// Node re-reads TZ on assignment (DateTimeConfigurationChangeNotification).
process.env.TZ = 'UTC';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore } from '../../src/auth/store';
import { clearMeProfileCache } from '../../src/auth/useMe';
import { setLang } from '../../src/i18n';
import { UserDetailPage } from '../../src/pages/UserDetailPage';

const EM_DASH = '—';

const wrap = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/orgs/users/u-bob']}>
        <Routes>
          <Route path="/orgs/users/:id" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

const meFull = {
  username: 'alice',
  display_name: 'Alice',
  permissions: ['user:view', 'user:edit'],
  effectiveDataScope: 'all',
};

/** One `GET /admin/users/:id` payload, overridable per test. */
const userFull = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'u-bob',
  org_id: 'o1',
  username: 'bob',
  display_name: 'Bob',
  email: 'bob@corp.example',
  phone: null,
  position: 'Engineer',
  level: 'P6',
  timezone: null,
  extra_roles: [],
  status: 'active',
  joined_at: '2026-01-05T00:00:00.000Z',
  last_login_at: null,
  last_login_ip: null,
  last_login_device: null,
  created_at: '2026-08-26T00:00:00.000Z',
  departments: [],
  deptIds: [],
  recent_logins: [],
  ...overrides,
});

/** Route the four page queries by URL rather than by call order — the page
 *  issues them concurrently, and `/me` is deferred a tick behind them. */
function mockPageData(user: Record<string, unknown>): void {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    // Checked before `/admin/users/`, which this path also contains.
    if (url.includes('/sso-binding')) return Promise.resolve(json(null));
    if (url.includes('/admin/users/')) return Promise.resolve(json(user));
    if (url.includes('/admin/roles')) return Promise.resolve(json([]));
    if (url.includes('/admin/departments')) return Promise.resolve(json([]));
    if (url.includes('/me')) return Promise.resolve(json(meFull));
    return Promise.resolve(json({}));
  });
}

/** The value cell of an InfoGrid row, matched by its label text. */
function infoValue(label: string): string {
  return screen.getByText(label).nextElementSibling?.textContent ?? '';
}

describe('pages/UserDetailPage — timestamps', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearMeProfileCache();
    setLang('en');
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] },
    });
  });

  test('renders an em dash for an absent timestamp', async () => {
    mockPageData(userFull({ joined_at: null, last_login_at: null }));
    render(wrap(<UserDetailPage />));
    await screen.findByRole('heading', { name: 'Bob' });
    expect(infoValue('Join date')).toBe(EM_DASH);
    expect(infoValue('Last login')).toBe(EM_DASH);
  });

  test('renders an em dash for an unparseable timestamp instead of crashing', async () => {
    mockPageData(userFull({ created_at: 'not-a-timestamp' }));
    // A throw inside a cell's render would escape the query and take the page
    // with it, so reaching the profile heading is the assertion. The em dash
    // is what separates this from the previous `new Date(ts).toLocaleString()`,
    // which rendered "Invalid Date" for the same input — the assertion that
    // actually fails if the shared formatter is reverted.
    expect(() => render(wrap(<UserDetailPage />))).not.toThrow();
    await screen.findByRole('heading', { name: 'Bob' });
    expect(infoValue('Created at')).toBe(EM_DASH);
  });

  test('renders a parseable timestamp in the shared analytics format', async () => {
    mockPageData(
      userFull({
        created_at: '2026-10-22T03:04:05.000Z',
        recent_logins: [
          { id: 'l1', ts: '2026-10-22T03:04:05.000Z', ip: '10.0.0.1', device: null, result: 'success' },
        ],
      })
    );
    render(wrap(<UserDetailPage />));
    await screen.findByRole('heading', { name: 'Bob' });
    // Pins the shape to the shared `YYYY/MM/DD HH:mm:ss` one, which — unlike
    // `toLocaleString()` — does not vary with the browser's locale. This is a
    // forward pin, not the discriminating assertion: the test above is (see
    // its comment).
    expect(infoValue('Created at')).toBe('2026/10/22 03:04:05');
    expect(screen.getByRole('table')).toHaveTextContent('2026/10/22 03:04:05');
  });
});