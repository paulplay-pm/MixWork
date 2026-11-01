import type { RootState } from '../store';

/**
 * Whether the desktop is running in multi-tenant enterprise mode.
 *
 * When `window.electron.enterpriseMt` is present, the enterprise bridge is the
 * active source of truth: the legacy youdao consumer/enterprise redux auth
 * never populates, but the user IS logged into the enterprise server. This
 * selector is what the artifact share/publish/library/sites/model flows use to
 * treat that user as authenticated.
 */
export const selectIsEnterpriseAccount = (_state: RootState): boolean => (
  typeof window !== 'undefined'
  && (window as unknown as { electron?: { enterpriseMt?: unknown } })
    .electron?.enterpriseMt != null
);
