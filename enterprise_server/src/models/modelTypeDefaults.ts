import { pool } from '../db/pool';

/**
 * The org's default model PER TYPE.
 *
 * One default per (org, type): the model a capability falls back to when the
 * caller did not name a model. The pointer lives beside the catalog rather
 * than on the model row, because a model can carry several types and each
 * type has its own default.
 */
export const modelTypeDefaults = {
  /** The default model id for a type, or null. */
  async get(orgId: string, type: string): Promise<string | null> {
    const r = await pool.query<{ model_id: string }>(
      `SELECT model_id FROM model_type_defaults WHERE org_id = $1 AND type = $2`,
      [orgId, type],
    );
    return r.rows[0]?.model_id ?? null;
  },

  /** Point the type at a model. Replaces any previous default. */
  async set(orgId: string, type: string, modelId: string): Promise<void> {
    await pool.query(
      `INSERT INTO model_type_defaults (org_id, type, model_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (org_id, type)
       DO UPDATE SET model_id = EXCLUDED.model_id, updated_at = now()`,
      [orgId, type, modelId],
    );
  },

  /** Clear the type's default. */
  async clear(orgId: string, type: string): Promise<void> {
    await pool.query(`DELETE FROM model_type_defaults WHERE org_id = $1 AND type = $2`, [
      orgId,
      type,
    ]);
  },

  /** Every default in the org: `[{ type, modelId }]`. */
  async listForOrg(orgId: string): Promise<Array<{ type: string; modelId: string }>> {
    const r = await pool.query<{ type: string; model_id: string }>(
      `SELECT type, model_id FROM model_type_defaults WHERE org_id = $1 ORDER BY type`,
      [orgId],
    );
    return r.rows.map((row) => ({ type: row.type, modelId: row.model_id }));
  },
};
