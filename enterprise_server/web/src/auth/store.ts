import { create } from 'zustand';

import type { Claims } from '../api/types';
import { base64UrlDecode } from './jwt';

/** Why the session ended. `session-expired` is not the admin's doing — the
 *  token lapsed and could not be renewed — and the login page tells them so
 *  instead of leaving them to wonder why they were signed out. */
export type LogoutReason = 'manual' | 'session-expired';

interface AuthState {
  token: string | null;
  claims: Claims | null;
  /** Why the last logout happened; null while signed in. */
  logoutReason: LogoutReason | null;
  login: (token: string) => void;
  logout: (reason?: LogoutReason) => void;
  hasCapability: (role: string) => boolean;
}

function decode(token: string): Claims {
  // A malformed token must not crash the login flow: the token is still valid
  // for API calls (the server re-validates it), so fall back to empty claims
  // and let the app degrade gracefully rather than refusing to sign in.
  try {
    return JSON.parse(base64UrlDecode(token.split('.')[1])) as Claims;
  } catch {
    return { sub: '', orgId: '', roles: [] };
  }
}

/** localStorage key for the session JWT. */
const TOKEN_KEY = 'mixcwork.enterprise.auth.token';

/**
 * True when the JWT's `exp` claim (seconds, per RFC 7519) is in the past. A
 * token with no readable `exp` is treated as non-expiring: the server
 * re-validates every request, so we never proactively drop a token we can't
 * parse — we just keep it until the server says 401.
 */
export function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(base64UrlDecode(token.split('.')[1])) as { exp?: number };
    return typeof payload.exp === 'number' && Date.now() / 1000 >= payload.exp;
  } catch {
    return false;
  }
}

interface StoredSession {
  token: string | null;
  claims: Claims | null;
  /** True when a stored token was dropped because it had already expired. */
  expired: boolean;
}

/**
 * Restore the session from localStorage on a full page load (a browser refresh
 * wipes in-memory JS state, so without this the app would bounce every reload
 * back to /login). Returns an empty session if nothing is stored or the stored
 * token is expired. An expired token is also removed so it doesn't linger, and
 * reported as such: reloading a tab after the session lapsed is the most
 * common way an admin comes back to the login form, so the page must be able
 * to explain why it is empty.
 */
export function readStoredSession(): StoredSession {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(TOKEN_KEY);
  } catch {
    return { token: null, claims: null, expired: false }; // localStorage unavailable
  }
  if (!stored) return { token: null, claims: null, expired: false };
  if (isTokenExpired(stored)) {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    return { token: null, claims: null, expired: true };
  }
  return { token: stored, claims: decode(stored), expired: false };
}

const initialSession = readStoredSession();

export const useAuthStore = create<AuthState>((set, get) => ({
  token: initialSession.token,
  claims: initialSession.claims,
  // A page load that threw an expired token away is a session that ended
  // without the admin asking, so the login page says so.
  logoutReason: initialSession.expired ? 'session-expired' : null,
  login: (token) => {
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* localStorage unavailable */ }
    set({ token, claims: decode(token), logoutReason: null });
  },
  logout: (reason: LogoutReason = 'manual') => {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* localStorage unavailable */ }
    set({ token: null, claims: null, logoutReason: reason });
  },
  hasCapability: (role) => {
    const { claims } = get();
    if (!claims) return false;
    return claims.roles.includes('super_admin') || claims.roles.includes(role);
  },
}));
