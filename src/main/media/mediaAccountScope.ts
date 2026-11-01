import {
  type AccountOwnerUser,
  createAccountOwnerKey,
  createEnterpriseSessionAccountOwnerKey,
} from '../../shared/auth/accountOwner';

export interface MediaAccountScopeSources {
  /**
   * The legacy consumer profile cached in the kv store under `auth_user`.
   * Only the legacy youdao login ever wrote it.
   */
  legacyUser: AccountOwnerUser | null;
  /** The legacy enterprise account context (numeric enterprise id). */
  legacyEnterpriseId: number | null;
  /** The multi-tenant enterprise session (org + user). */
  enterpriseSession: { orgId: string; userId: string } | null;
}

/**
 * The account that owns a media turn.
 *
 * The desktop has two account systems that never overlap:
 *
 * - the legacy youdao consumer/enterprise login, whose identity is the
 *   `auth_user` profile plus, for an enterprise account, the account context;
 * - the multi-tenant enterprise bridge (`enterpriseMt`), whose identity is the
 *   enterprise session — that deployment never writes an `auth_user` profile
 *   and never persists an account context, because the enterprise server
 *   URL makes the main process skip the legacy context refresh.
 *
 * Keying only on the first system left every media call in an enterprise
 * deployment without an account scope: the tool answered "this session is not
 * bound to a signed-in account", and the model picker listed no media models
 * at all.
 */
export const resolveMediaAccountOwnerKey = (
  sources: MediaAccountScopeSources,
): string | null => {
  const legacyKey = createAccountOwnerKey({
    user: sources.legacyUser,
    enterpriseId: sources.legacyEnterpriseId,
  });
  if (legacyKey) return legacyKey;

  const session = sources.enterpriseSession;
  if (!session) return null;
  return createEnterpriseSessionAccountOwnerKey({
    orgId: session.orgId,
    userId: session.userId,
  });
};
