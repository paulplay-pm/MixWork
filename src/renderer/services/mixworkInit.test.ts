import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { mixworkService } from './mixwork';

type CoworkServiceInternals = {
  initialized: boolean;
  setupStreamListeners: () => void;
  setupOpenClawEngineListeners: () => void;
};

const internals = mixworkService as unknown as CoworkServiceInternals;

beforeEach(() => {
  vi.useFakeTimers();
  mixworkService.destroy();
  vi.spyOn(internals, 'setupStreamListeners').mockImplementation(() => undefined);
  vi.spyOn(internals, 'setupOpenClawEngineListeners').mockImplementation(() => undefined);
});

afterEach(() => {
  mixworkService.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('initialization settles after isolated IPC rejection and timeout', async () => {
  vi.spyOn(mixworkService, 'loadConfig').mockRejectedValue(new Error('config unavailable'));
  vi.spyOn(mixworkService, 'loadSessions').mockImplementation(
    () => new Promise<void>(() => undefined),
  );
  vi.spyOn(mixworkService, 'loadOpenClawEngineStatus').mockResolvedValue(null);

  const initialization = mixworkService.init();
  await vi.advanceTimersByTimeAsync(12_001);

  await expect(initialization).resolves.toBeUndefined();
  expect(internals.initialized).toBe(true);
});
