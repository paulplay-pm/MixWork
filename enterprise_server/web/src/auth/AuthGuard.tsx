import type { JSX, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { t } from '../i18n';
import { isPermissionPoint, passesAccess } from '../shared/permissions';
import { useAuth } from './useAuth';
import { usePermissions } from './usePermissions';

interface Props {
  /**
   * Either a coarse role code (`org_admin`, from the JWT claims) or a fine
   * permission point (`usage:view`, from `/me`). A value containing `:` is a
   * point — see `isPermissionPoint`.
   */
  requires?: string;
  children: ReactNode;
}

function GatePending(): JSX.Element {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-[var(--text-secondary)]">
      {t('common.loading')}
    </div>
  );
}

export function AuthGuard({ requires, children }: Props): JSX.Element {
  const { token, hasCapability } = useAuth();
  const { hasPermission, loading } = usePermissions();
  const location = useLocation();

  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!requires) return <>{children}</>;
  // A fine point lives ONLY in `/me`, so until that resolves the answer is
  // UNKNOWN, not "no". Redirecting here would bounce the user off a page they
  // can see and then let them back on the next render — a flash that also
  // makes the page look broken. The coarse role path needs no request and
  // never waits.
  if (isPermissionPoint(requires) && loading) return <GatePending />;
  if (!passesAccess(requires, hasCapability, hasPermission)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
