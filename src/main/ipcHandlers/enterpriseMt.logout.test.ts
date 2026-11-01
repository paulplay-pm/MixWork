import { beforeEach, describe, expect, test, vi } from 'vitest';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../auth/enterpriseClient', () => ({
  EnterpriseApiError: class EnterpriseApiError extends Error {},
  enterpriseClient: {
    logout: vi.fn(),
  },
}));

vi.mock('../auth/enterpriseModelCache', () => ({
  enterpriseModelCache: { wipe: vi.fn() },
}));

vi.mock('../auth/enterpriseModelPrefs', () => ({
  enterpriseModelPrefs: {},
}));

vi.mock('../auth/enterpriseServerUrlStore', () => ({
  enterpriseServerUrlStore: { load: () => null, save: vi.fn() },
}));

vi.mock('../auth/loginGate', () => ({
  loginGate: { requireEnterprise: () => ({ sub: 'u', orgId: 'o', roles: [] }) },
}));

vi.mock('../auth/sessionStorage', () => ({
  sessionStorage: { load: () => null, save: vi.fn(), clear: vi.fn() },
}));

vi.mock('./sso', () => ({
  registerSsoHandlers: vi.fn(),
}));

import { EnterpriseIpcChannel } from '../../shared/enterprise/constants';
import { enterpriseClient } from '../auth/enterpriseClient';
import { enterpriseModelCache } from '../auth/enterpriseModelCache';
import { registerEnterpriseMtHandlers, setEnterpriseLogoutHook } from './enterpriseMt';

async function logout(): Promise<void> {
  const handler = registeredHandlers.get(EnterpriseIpcChannel.Logout);
  if (!handler) throw new Error('logout handler not registered');
  await handler({});
}

describe('EnterpriseIpcChannel.Logout handler', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    setEnterpriseLogoutHook(null);
    registerEnterpriseMtHandlers();
    vi.mocked(enterpriseClient.logout).mockReset();
    vi.mocked(enterpriseClient.logout).mockResolvedValue(undefined);
    vi.mocked(enterpriseModelCache.wipe).mockReset();
  });

  test('runs the post-logout hook so the departed member\'s credentials are dropped', async () => {
    const hook = vi.fn();
    setEnterpriseLogoutHook(hook);

    await logout();

    expect(hook).toHaveBeenCalledTimes(1);
  });

  test('still logs out and wipes the cache when the hook throws', async () => {
    const hook = vi.fn(() => {
      throw new Error('sync exploded');
    });
    setEnterpriseLogoutHook(hook);

    await expect(logout()).resolves.toBeUndefined();

    expect(enterpriseClient.logout).toHaveBeenCalledTimes(1);
    expect(enterpriseModelCache.wipe).toHaveBeenCalledTimes(1);
  });

  test('logs out without a hook', async () => {
    await expect(logout()).resolves.toBeUndefined();

    expect(enterpriseClient.logout).toHaveBeenCalledTimes(1);
    expect(enterpriseModelCache.wipe).toHaveBeenCalledTimes(1);
  });
});
