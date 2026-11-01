import { EnterpriseAccountMode } from '../enterpriseAccount/constants';

export interface AccountOwnerUser {
  userId?: unknown;
  id?: unknown;
  yid?: unknown;
  accountMode?: unknown;
}

const AccountOwnerKeyPrefix = {
  Personal: 'personal:',
  Enterprise: 'enterprise:',
} as const;

const normalizeAccountOwnerPart = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
};

export const resolveAccountOwnerUserId = (
  user: AccountOwnerUser | null | undefined,
): string | null => (
  normalizeAccountOwnerPart(user?.userId)
  ?? normalizeAccountOwnerPart(user?.id)
  ?? normalizeAccountOwnerPart(user?.yid)
);

export const createAccountOwnerKey = (input: {
  user: AccountOwnerUser | null | undefined;
  enterpriseId?: number | null;
}): string | null => {
  const userId = resolveAccountOwnerUserId(input.user);
  if (!userId) return null;
  if (typeof input.enterpriseId === 'number' && Number.isFinite(input.enterpriseId)) {
    return `${AccountOwnerKeyPrefix.Enterprise}${userId}:${input.enterpriseId}`;
  }
  const accountMode = typeof input.user?.accountMode === 'string'
    ? input.user.accountMode.trim().toLowerCase()
    : '';
  return accountMode === EnterpriseAccountMode.Enterprise
    ? null
    : `${AccountOwnerKeyPrefix.Personal}${userId}`;
};

/**
 * Owner key for the multi-tenant enterprise bridge (`enterpriseMt`).
 *
 * That deployment has no consumer profile at all: the account identity IS the
 * enterprise session (org + user). The key keeps the `enterprise:` prefix and
 * the `<userId>:<orgId>` shape of the legacy enterprise key, so a session
 * scoped to one org never matches another org's session.
 */
export const createEnterpriseSessionAccountOwnerKey = (input: {
  orgId?: unknown;
  userId?: unknown;
}): string | null => {
  const orgId = normalizeAccountOwnerPart(input.orgId);
  const userId = normalizeAccountOwnerPart(input.userId);
  if (!orgId || !userId) return null;
  return `${AccountOwnerKeyPrefix.Enterprise}${userId}:${orgId}`;
};
