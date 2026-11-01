// Proactive rotation of the enterprise session token.
//
// The enterprise JWT is short-lived (~1h) and — unlike a consumer token — it
// cannot be refreshed after it has already expired: POST /auth/refresh
// re-verifies the CURRENT token, so a stale one is rejected. The desktop
// already works around this (src/main/libs/enterpriseJwtRefresh.ts); the
// console did not, which is why every write in the console answered with a
// bare `http 401 unauthorized` once the token lapsed.
//
// So we rotate the token while it is still valid. This module owns the
// single-flight decision; the callers inject the collaborators, which keeps it
// testable without a live server.

import { readJwtExpMs } from './jwt';

export const DEFAULT_REFRESH_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_REFRESH_INTERVAL_MS = 60 * 1000;

export type SessionRefreshStatus =
  | 'refreshed'
  | 'not-due'
  | 'not-logged-in'
  | 'jwt-expired'
  | 'refresh-failed';

export interface SessionRefreshResult {
  status: SessionRefreshStatus;
}

export interface SessionRefreshDeps {
  /** The current session token, or null when logged out. */
  getToken: () => string | null;
  /** Rotate the token (POST /auth/refresh with the current token). */
  refresh: () => Promise<string>;
  /** Persist the rotated token. */
  persist: (token: string) => void;
  now?: () => number;
  /** Refresh when the token expires within this window (ms). */
  refreshWindowMs?: number;
}

// Single-flight: the periodic refresher, a focus-driven retry and a reactive
// recovery can all fire around the same moment; they must share one request.
let inFlight: Promise<SessionRefreshResult> | null = null;

/**
 * Rotate the session token when it is within the refresh window (and still
 * valid). Returns a status rather than throwing:
 *  - `refreshed`      — the token was rotated and persisted.
 *  - `not-due`        — the token is still fresh; nothing to do.
 *  - `not-logged-in`  — no session; the caller should surface the login gate.
 *  - `jwt-expired`    — the token is already past expiry and cannot be
 *                        rotated; the caller should fall through to re-login.
 *  - `refresh-failed` — the refresh request failed; the next trigger retries.
 */
export function refreshSessionIfDue(deps: SessionRefreshDeps): Promise<SessionRefreshResult> {
  if (inFlight) return inFlight;

  const now = deps.now ?? Date.now;
  const refreshWindowMs = deps.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;

  const run = async (): Promise<SessionRefreshResult> => {
    const token = deps.getToken();
    if (!token) return { status: 'not-logged-in' };

    const exp = readJwtExpMs(token);
    // An already-expired token cannot be rotated — the refresh endpoint would
    // reject the stale token. Report that so the caller falls through to
    // re-login rather than attempting a doomed refresh.
    if (exp !== null && exp <= now()) return { status: 'jwt-expired' };

    // Only rotate when the window is actually closing. `exp` null (an
    // unparseable claim) is treated as due so a skewed token still rotates
    // rather than 401ing downstream.
    const due = exp === null || exp - now() <= refreshWindowMs;
    if (!due) return { status: 'not-due' };

    try {
      const next = await deps.refresh();
      if (!next || next === token) {
        // No new material to apply (the server echoed the same token).
        return { status: 'not-due' };
      }
      deps.persist(next);
      return { status: 'refreshed' };
    } catch {
      return { status: 'refresh-failed' };
    }
  };

  const promise = run().finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

/**
 * Start the periodic rotation. Runs once immediately, then on an interval,
 * and once more whenever the tab comes back to the foreground (a background
 * tab's timers are throttled, so the tab may wake up long after the window
 * closed). Returns a stop function.
 */
export function startSessionRefresh(
  deps: SessionRefreshDeps & { intervalMs?: number },
): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const tick = (): void => {
    void refreshSessionIfDue(deps);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') tick();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    clearInterval(timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

/** Test helper: clear the single-flight latch between cases. */
export function _resetSessionRefreshForTest(): void {
  inFlight = null;
}
