import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', () => ({ pool: { query: vi.fn() } }));

import { _resetMemberStatusCacheForTest, resolveMemberStatus } from '../../src/auth/memberStatus';
import { pool } from '../../src/db/pool';

const query = vi.mocked(pool.query);

beforeEach(() => {
  _resetMemberStatusCacheForTest();
  query.mockReset();
});

describe('resolveMemberStatus', () => {
  test('an absent row is missing', async () => {
    query.mockResolvedValue({ rows: [] } as never);
    expect(await resolveMemberStatus('u1')).toEqual({ kind: 'missing' });
  });

  test('an active member reports its status', async () => {
    query.mockResolvedValue({ rows: [{ status: 'active' }] } as never);
    expect(await resolveMemberStatus('u1')).toEqual({
      kind: 'status',
      status: 'active',
      isSuperAdmin: false,
    });
  });

  test('an active super admin is reported as such, from the row not the token', async () => {
    query.mockResolvedValue({
      rows: [{ status: 'active', extra_roles: ['super_admin'] }],
    } as never);
    expect(await resolveMemberStatus('u1')).toEqual({
      kind: 'status',
      status: 'active',
      isSuperAdmin: true,
    });
  });

  test('a plain member is not a super admin', async () => {
    query.mockResolvedValue({
      rows: [{ status: 'active', extra_roles: ['member'] }],
    } as never);
    expect(await resolveMemberStatus('u1')).toEqual({
      kind: 'status',
      status: 'active',
      isSuperAdmin: false,
    });
  });

  test('a disabled member reports its status', async () => {
    query.mockResolvedValue({ rows: [{ status: 'disabled' }] } as never);
    expect(await resolveMemberStatus('u1')).toEqual({
      kind: 'status',
      status: 'disabled',
      isSuperAdmin: false,
    });
  });

  test('a db error fails open', async () => {
    query.mockRejectedValue(new Error('boom'));
    expect(await resolveMemberStatus('u1')).toEqual({ kind: 'error' });
  });
});

describe('the 30s cache', () => {
  test('reuses the first result inside the window', async () => {
    query.mockResolvedValue({ rows: [{ status: 'active' }] } as never);
    await resolveMemberStatus('u1');
    await resolveMemberStatus('u1');
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('caches the error outcome too, so a flapping db cannot stampede', async () => {
    query.mockRejectedValue(new Error('boom'));
    await resolveMemberStatus('u1');
    await resolveMemberStatus('u1');
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('the test helper clears it', async () => {
    query.mockResolvedValue({ rows: [{ status: 'active' }] } as never);
    await resolveMemberStatus('u1');
    _resetMemberStatusCacheForTest();
    await resolveMemberStatus('u1');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
