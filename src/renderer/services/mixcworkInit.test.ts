import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { mixcworkService } from './mixcwork';

type CoworkServiceInternals = {
  initialized: boolean;
  setupStreamListeners: () => void;
  setupOpenClawEngineListeners: () => void;
};

const internals = mixcworkService as unknown as CoworkServiceInternals;

beforeEach(() => {
  vi.useFakeTimers();
  mixcworkService.destroy();
  vi.spyOn(internals, 'setupStreamListeners').mockImplementation(() => undefined);
  vi.spyOn(internals, 'setupOpenClawEngineListeners').mockImplementation(() => undefined);
});

afterEach(() => {
  mixcworkService.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('initialization settles after isolated IPC rejection and timeout', async () => {
  vi.spyOn(mixcworkService, 'loadConfig').mockRejectedValue(new Error('config unavailable'));
  vi.spyOn(mixcworkService, 'loadSessions').mockImplementation(
    () => new Promise<void>(() => undefined),
  );
  vi.spyOn(mixcworkService, 'loadOpenClawEngineStatus').mockResolvedValue(null);

  const initialization = mixcworkService.init();
  await vi.advanceTimersByTimeAsync(12_001);

  await expect(initialization).resolves.toBeUndefined();
  expect(internals.initialized).toBe(true);
});
