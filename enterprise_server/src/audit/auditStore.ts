import { pool } from '../db/pool';
import type { TxClient } from '../db/testDb';

export interface AuditEventInput {
  orgId: string;
  userId?: string | null;
  targetUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  payload?: unknown;
  /** Optional transaction client so the audit row commits atomically with the
   * write it records. Defaults to the module pool (the common case). */
  tx?: TxClient;
}

export const auditStore = {
  async write(input: AuditEventInput): Promise<void> {
    const db = input.tx ?? pool;
    await db.query(
      `INSERT INTO audit_events(org_id,user_id,target_user_id,action,target_type,target_id,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.orgId,
        input.userId ?? null,
        input.targetUserId ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload),
      ]
    );
  },
};
