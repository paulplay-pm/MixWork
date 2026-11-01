import { useMemo } from 'react';

import { useMe } from './useMe';

export interface UsePermissionsResult {
  /** The caller's fine permission points, e.g. 'dept:edit'. */
  permissions: Set<string>;
  /** True when the caller holds the given fine permission point. */
  hasPermission: (point: string) => boolean;
  /** Coarse data-scope axis from `/me`: 'all' | 'self' | 'dept' (or '' until loaded). */
  effectiveDataScope: string;
  /** True while `/me` is still in flight. A gate must WAIT on this rather than
   * read "not loaded yet" as "not permitted" — that mistake redirects the user
   * out of a page they are entitled to, then lets them back in. */
  loading: boolean;
}

/**
 * Fine-grained permission gate for admin pages. The fine points live ONLY in
 * `/me` (the JWT claims carry coarse roles, not points), so this builds on the
 * existing `useMe()` hook — it does NOT fetch `/me` a second time; the profile
 * is read into a `Set` with `useMemo`.
 *
 * This complements (and does not replace) `useAuth().hasCapability(role)`,
 * which stays the coarse role-based gate used by Sidebar/AuthGuard/UserMenu.
 */
export function usePermissions(): UsePermissionsResult {
  const { profile, loading } = useMe();
  const permissions = useMemo(() => new Set<string>(profile?.permissions ?? []), [profile]);
  const effectiveDataScope = profile?.effectiveDataScope ?? '';
  const hasPermission = useMemo(
    () => (point: string) => permissions.has(point),
    [permissions]
  );
  return { permissions, hasPermission, effectiveDataScope, loading };
}
