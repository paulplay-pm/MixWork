import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore } from '../../src/auth/store';
import { clearMeProfileCache } from '../../src/auth/useMe';
import { Sidebar } from '../../src/components/Sidebar';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

function renderSidebar(initialPath = '/'): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar />
    </MemoryRouter>
  );
}

/** The nav items, in the order the sidebar renders them. */
function navLabels(): string[] {
  return within(screen.getByRole('navigation'))
    .getAllByRole('link')
    .map((link) => (link.textContent ?? '').trim());
}

describe('components/Sidebar', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // The nav now gates on fine points, which come from `/me` — and `/me`'s
    // profile cache is module-scoped and keyed by token. Drop it so one test's
    // resolved profile cannot decide another test's nav.
    clearMeProfileCache();
    // /me is called by the footer (UserMenu → useMe); a 404 makes it degrade to
    // the JWT `sub` so the tests assert the fallback path deterministically.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1_admin', orgId: 'o1', roles: ['super_admin'] },
    });
  });

  test('renders brand block', () => {
    renderSidebar();
    expect(screen.getByText(/MixcWork Console/i)).toBeInTheDocument();
  });

  test('renders all 5 nav section labels', async () => {
    // The monitoring items are gated on fine points, which live only in `/me`.
    // The default 404 mock would hide the section outright, so hand this case
    // the profile a super_admin actually gets (migration 052 stamps these
    // points onto super_admin/org_admin/auditor).
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          username: 'u1_admin',
          display_name: null,
          permissions: ['usage:view', 'audit:view'],
          effectiveDataScope: 'all',
        }),
        { status: 200 }
      )
    );
    renderSidebar();
    expect(screen.getAllByText(/Overview/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Configuration/i).length).toBeGreaterThan(0);
    // The monitoring group now holds 用量 + 审计, so it is named for them
    // rather than for the generic "Monitoring". It appears only once `/me`
    // resolves — a point-gated item is never shown on an unknown permission
    // set, then pulled.
    expect(
      await screen.findByText(/Usage & audit/i)
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Organization/i).length).toBeGreaterThan(0);
    // Versions is a group of its own, between Configuration and Usage.
    expect(screen.getAllByText(/Versions/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/System/i)).toBeNull();
  });

  test('versions heads its own group, ahead of usage and audit', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          username: 'u1_admin',
          display_name: null,
          permissions: ['usage:view', 'audit:view'],
          effectiveDataScope: 'all',
        }),
        { status: 200 }
      )
    );
    renderSidebar();
    // Usage and audit are gated on fine points, so they only appear once
    // `/me` resolves.
    await screen.findByText(/Usage & audit/i);
    const labels = navLabels();
    expect(labels.indexOf('Versions')).toBeGreaterThan(labels.indexOf('Connectors'));
    expect(labels.indexOf('Versions')).toBeLessThan(labels.indexOf('Usage'));
  });

  test('the identity provider sits after roles in the organization group', async () => {
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'a', orgId: 'o1', roles: ['org_admin'] } });
    renderSidebar();
    const labels = navLabels();
    expect(labels.indexOf('SSO')).toBeGreaterThan(labels.indexOf('Roles'));
    // It left the capability catalog entirely.
    expect(labels.indexOf('SSO')).toBeGreaterThan(labels.indexOf('Agent management'));
  });

  test('renders the footer name from the JWT sub when /me is unavailable', () => {
    renderSidebar();
    expect(screen.getByText(/u1_admin/i)).toBeInTheDocument();
    expect(screen.getByText(/Super admin/i)).toBeInTheDocument();
  });

  test('active route gets accent background', () => {
    renderSidebar('/config/providers');
    const link = screen.getByRole('link', { name: /Model configuration/i });
    expect(link.className).toMatch(/bg-\[var\(--accent-light\)\]/);
    expect(link.className).toMatch(/text-\[var\(--accent-primary\)\]/);
  });

  test('hides org_admin-gated items when user lacks capability', () => {
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['user'] },
    });
    renderSidebar();
    expect(screen.queryByRole('link', { name: /Users/i })).toBeNull();
  });

  test('shows the Connectors nav item for org_admin', () => {
    // The nav entry is `t('nav.mcpManage')`, which the en dictionary renders
    // as 'Connectors' — the MCP surface is labelled Connectors throughout
    // (breadcrumb, tabs, drawer), not 'MCP management'.
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'a', orgId: 'o1', roles: ['org_admin'] } });
    renderSidebar('/config/mcp-manage');
    expect(screen.getByRole('link', { name: /Connectors/i })).toBeInTheDocument();
  });

  test('hides the Connectors nav item when lacking org_admin', () => {
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'u', orgId: 'o1', roles: ['user'] } });
    renderSidebar();
    expect(screen.queryByRole('link', { name: /Connectors/i })).toBeNull();
  });
});
