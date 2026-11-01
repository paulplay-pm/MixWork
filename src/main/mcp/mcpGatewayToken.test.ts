import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../auth/enterpriseClient', () => ({
  enterpriseClient: { issueGatewayToken: vi.fn() },
}));
vi.mock('../auth/sessionStorage', () => ({ sessionStorage: { load: vi.fn() } }));

import { enterpriseClient } from '../auth/enterpriseClient';
import { sessionStorage } from '../auth/sessionStorage';
import { ensureGatewayToken } from './mcpGatewayToken';

const issue = vi.mocked(enterpriseClient.issueGatewayToken);
const load = vi.mocked(sessionStorage.load);

const DAY = 86_400_000;
const later = (days: number): string => new Date(Date.now() + days * DAY).toISOString();

const record = (o: Record<string, unknown> = {}) => ({
  consumption: 'gateway' as const,
  serverKey: 'sk',
  gatewayToken: 't',
  gatewayTokenOwner: 'u1',
  gatewayTokenExpiresAt: later(60),
  ...o,
});

describe('ensureGatewayToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    load.mockReturnValue({ userId: 'u1' } as ReturnType<typeof sessionStorage.load>);
  });

  test('a fresh token owned by the current user is used as-is', async () => {
    const r = record();
    await expect(ensureGatewayToken(r)).resolves.toEqual({
      token: 't',
      owner: 'u1',
      expiresAt: r.gatewayTokenExpiresAt,
    });
    expect(issue).not.toHaveBeenCalled();
  });

  test('a token minted for someone else is never used', async () => {
    // One timestamp for both the mock and the assertion: computing it twice
    // lets a millisecond tick between the calls and fail the comparison.
    const expiresAt = later(90);
    issue.mockResolvedValue({ token: 'new', expiresAt });
    // Two members share the desktop app on one machine: the previous member's
    // token must not authorize the next member's calls.
    await expect(ensureGatewayToken(record({ gatewayToken: 'A-token', gatewayTokenOwner: 'u2' }))).resolves.toEqual({
      token: 'new',
      owner: 'u1',
      expiresAt,
    });
    expect(issue).toHaveBeenCalledWith('sk');
  });

  test('a token inside the 15-day window is refreshed early', async () => {
    issue.mockResolvedValue({ token: 'new', expiresAt: later(90) });
    await expect(
      ensureGatewayToken(record({ gatewayTokenExpiresAt: later(10) })),
    ).resolves.toMatchObject({ token: 'new' });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  test('a token of exactly 15 days is still considered fresh', async () => {
    await ensureGatewayToken(record({ gatewayTokenExpiresAt: later(15.1) }));
    expect(issue).not.toHaveBeenCalled();
  });

  test('an unreadable expiry is treated as expired', async () => {
    issue.mockResolvedValue({ token: 'new', expiresAt: later(90) });
    await expect(
      ensureGatewayToken(record({ gatewayTokenExpiresAt: 'not-a-date' })),
    ).resolves.toMatchObject({ token: 'new' });
  });

  test('logged out yields null and sends no request', async () => {
    load.mockReturnValue(null);
    await expect(ensureGatewayToken(record())).resolves.toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });

  test('a direct or partial record yields null', async () => {
    await expect(ensureGatewayToken(record({ consumption: 'direct' }))).resolves.toBeNull();
    await expect(ensureGatewayToken(record({ serverKey: undefined }))).resolves.toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });
});
