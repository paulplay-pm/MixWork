import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest';

describe('mixcwork-server version', () => {
  let prevVersion: string | undefined;
  let log: MockInstance<[message?: any, ...optionalParams: any[]], void>;

  beforeEach(() => {
    vi.resetModules();
    prevVersion = process.env.VERSION;
    process.env.VERSION = 'v2026.10.15-test';
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    if (prevVersion === undefined) delete process.env.VERSION;
    else process.env.VERSION = prevVersion;
  });

  test('prints VERSION env when set', async () => {
    const { run } = await import('../../src/cli/version');
    run();
    expect(log).toHaveBeenCalledWith('mixcwork-server v2026.10.15-test');
  });
});
