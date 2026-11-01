import { pool } from '../db/pool';
import { cardIdForSlot } from '../models/providerCards';
import { decrypt, encrypt } from './crypto';

/** Region hint for grouping providers in the admin UI / desktop picker. */
export type ProviderRegion = 'china' | 'global';

/** Display mask for a secret: keep first 3 + last 4, mask the middle. Not a
 * secret — purely a UI aid. Never returns the plaintext. */
/**
 * Upstream wire protocol — which ADAPTER to dispatch to, not which vendor.
 *
 * `openai`/`anthropic` are the LLM chat protocols the model proxy already
 * dispatches on. `realtime-asr`/`image-gen`/`video-gen` are the non-LLM
 * adapters the ASR and media backends resolve against, so an ASR or image
 * provider is stored in the same table as a chat provider rather than in a
 * parallel config surface.
 *
 * Kept as a const object + derived type (never bare string literals) because
 * four separate signatures in this file take it, and a hand-edited union in
 * one of them is how the others silently drift.
 */
export const ProviderProtocol = {
  Openai: 'openai',
  Anthropic: 'anthropic',
  RealtimeAsr: 'realtime-asr',
  ImageGen: 'image-gen',
  VideoGen: 'video-gen',
} as const;
export type ProviderProtocol = (typeof ProviderProtocol)[keyof typeof ProviderProtocol];

/** Tuple form, for `z.enum(...)` which needs a non-empty readonly tuple. */
export const PROVIDER_PROTOCOL_VALUES = Object.values(
  ProviderProtocol,
) as [ProviderProtocol, ...ProviderProtocol[]];

/** The chat protocols: the two wires a model LIST is meaningful for.
 *
 * A protocol switch WITHIN this family keeps the section's model list — the
 * model ids and their capabilities mean the same thing on both wires. A switch
 * ACROSS the boundary invalidates the list: a chat model id means nothing to
 * an ASR or image adapter. */
export const CHAT_PROTOCOLS: readonly ProviderProtocol[] = [
  ProviderProtocol.Openai,
  ProviderProtocol.Anthropic,
];

/** True when the protocol carries chat models. */
export function isChatProtocol(protocol: ProviderProtocol): boolean {
  return CHAT_PROTOCOLS.includes(protocol);
}

export function maskKey(key: string): string {
  if (!key || key.length <= 8) return '••••';
  const head = key.slice(0, 3);
  const tail = key.slice(-4);
  const mid = '•'.repeat(Math.min(key.length - 7, 12));
  return `${head}${mid}${tail}`;
}

export interface ProviderKeyView {
  id: string;
  org_id: string;
  provider: string;
  endpoint: string | null;
  label: string | null;
  enabled: boolean;
  region: ProviderRegion | null;
  default_base_url: string | null;
  website: string | null;
  description: string | null;
  api_key_masked: string | null;
  is_builtin: boolean;
  protocol: ProviderProtocol;
  /** "Coding Plan" (beta): when on the UI swaps the Base URL to the provider's
   * coding-specific endpoint. Persisted so it round-trips through the save. */
  coding_plan: boolean;
  /** Provider-specific settings. The ASR adapter reads `config.model` and
   * `config.limitSecondsToday`; the media model list is NOT here — it lives
   * in `model_catalog` (the retired `config.models` field is dropped on
   * write). Never holds a secret — the API key lives in its own encrypted
   * column. */
  config: Record<string, unknown>;
  status: 'unknown' | 'connected' | 'failed';
  latency_ms: number | null;
  last_test_at: string | null;
  created_at: string;
}

/**
 * The card a new key belongs to, when the caller did not name one.
 *
 * The 058 backfill numbered the keys of a (org, provider, protocol) group
 * by slot — 0, 1, 2 … in (is_builtin DESC, created_at ASC, id ASC) order.
 * A key added at runtime is the newest row of its group, so its slot is the
 * group's current size. The card id is the same deterministic expression
 * the backfill used, so a key added at runtime lands on the card the
 * backfill would have given it.
 *
 * A card holds AT MOST ONE section per protocol — a card's LLM capability
 * single-selects openai/anthropic, so two credentials of the same protocol
 * cannot share a card. When the deterministic card does not exist, the key
 * joins a card of the same vendor that has no section of this protocol yet
 * (a card the console created carries a random id but is still the same
 * vendor); otherwise it opens a new one.
 */
async function resolveCardId(
  orgId: string,
  provider: string,
  protocol: ProviderProtocol,
  createdBy?: string,
): Promise<string> {
  const count = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM provider_keys
      WHERE org_id = $1 AND provider = $2 AND protocol = $3`,
    [orgId, provider, protocol],
  );
  const slot = count.rows[0]?.n ?? 0;
  const deterministicId = cardIdForSlot(orgId, provider, slot);

  const byId = await pool.query(`SELECT id FROM provider_cards WHERE id = $1 AND org_id = $2`, [
    deterministicId,
    orgId,
  ]);
  if (byId.rowCount) return deterministicId;

  // A card of the same vendor with room for this protocol. The vendor's
  // default card (prefix == slug) wins over a renamed one.
  const sibling = await pool.query<{ id: string }>(
    `SELECT c.id
       FROM provider_cards c
      WHERE c.org_id = $1 AND c.provider = $2
        AND NOT EXISTS (
          SELECT 1 FROM provider_keys k
           WHERE k.card_id = c.id AND k.protocol = $3
        )
      ORDER BY (COALESCE(c.label, c.provider) = c.provider) DESC, c.created_at ASC, c.id ASC
      LIMIT 1`,
    [orgId, provider, protocol],
  );
  if (sibling.rowCount) return sibling.rows[0].id;

  // No card for this vendor yet: create the one the backfill would have.
  const label = slot === 0 ? null : `${provider} #${slot + 1}`;
  try {
    await pool.query(
      `INSERT INTO provider_cards (id, org_id, provider, label, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO NOTHING`,
      [deterministicId, orgId, provider, label, createdBy ?? null],
    );
  } catch (err) {
    // 23505 = the PREFIX is taken by another card (the label is unique per
    // org). That card is this vendor's card, so join it.
    if ((err as { code?: string }).code !== '23505') throw err;
    const taken = await pool.query<{ id: string }>(
      `SELECT id FROM provider_cards
        WHERE org_id = $1 AND COALESCE(label, provider) = $2
        LIMIT 1`,
      [orgId, label ?? provider],
    );
    if (taken.rowCount) return taken.rows[0].id;
    throw err;
  }
  return deterministicId;
}

export const providerKeyVault = {
  async add(input: {
    orgId: string;
    provider: string;
    plaintextKey?: string;
    label?: string;
    endpoint?: string;
    region?: ProviderRegion;
    defaultBaseUrl?: string;
    website?: string;
    createdBy?: string;
    isBuiltin?: boolean;
    protocol?: ProviderProtocol;
    /** "Coding Plan" flag (beta coding endpoint). Defaults to off. */
    codingPlan?: boolean;
    /** Whether the row starts enabled. Defaults to "a key was provided": a
     * keyless provider is created disabled (未启用) — it can't authenticate —
     * and is enabled later once a key is set. Pass `false` explicitly to force
     * disabled even with a key. */
    enabled?: boolean;
    /** Provider-specific settings (the media model list, the ASR model / daily
     * cap). Stored as JSONB; defaults to `{}`. */
    config?: Record<string, unknown>;
    /** The vendor card this key belongs to. When absent, the card is derived
     * from the key's slot — see `resolveCardId`. */
    cardId?: string;
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    const enabled = input.enabled ?? input.plaintextKey != null;
    const protocol = input.protocol ?? 'openai';
    const cardId = input.cardId ?? (await resolveCardId(input.orgId, input.provider, protocol, input.createdBy));
    await pool.query(
      `INSERT INTO provider_keys(
         id, org_id, provider, api_key_encrypted, api_key_masked,
         endpoint, label, region, default_base_url, website, created_by,
         is_builtin, protocol, coding_plan, enabled, config, card_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
      [
        id,
        input.orgId,
        input.provider,
        input.plaintextKey ? encrypt(input.plaintextKey) : null,
        input.plaintextKey ? maskKey(input.plaintextKey) : null,
        input.endpoint ?? null,
        input.label ?? null,
        input.region ?? null,
        input.defaultBaseUrl ?? null,
        input.website ?? null,
        input.createdBy ?? null,
        input.isBuiltin ?? false,
        protocol,
        input.codingPlan ?? false,
        enabled,
        JSON.stringify(input.config ?? {}),
        cardId,
      ],
    );
    return { id };
  },

  async list(orgId: string): Promise<ProviderKeyView[]> {
    // `last_test_at` is a `timestamptz`; pglite/pg return it as a `Date`, so
    // query it as such and normalize to an ISO string for the wire shape.
    const r = await pool.query<
      Omit<ProviderKeyView, 'last_test_at'> & {
        last_test_at: Date | null;
        api_key_encrypted: string | null;
      }
    >(
      `SELECT id, org_id, provider, endpoint, label, enabled,
              region, default_base_url, website,
              description, api_key_masked, api_key_encrypted,
              is_builtin, protocol, coding_plan, config, status, latency_ms, last_test_at, created_at
       FROM provider_keys WHERE org_id=$1 ORDER BY created_at DESC`,
      [orgId],
    );
    return Promise.all(
      r.rows.map(async (row) => {
        const { api_key_encrypted, ...rest } = row;
        let masked = row.api_key_masked;
        if (!masked && api_key_encrypted) {
          masked = maskKey(decrypt(api_key_encrypted)); // legacy row without a stored mask
        }
        return {
          ...rest,
          api_key_masked: masked,
          last_test_at: row.last_test_at ? row.last_test_at.toISOString() : null,
        };
      }),
    );
  },

  async getDecrypted(id: string): Promise<string> {
    const r = await pool.query<{ api_key_encrypted: string }>(
      `SELECT api_key_encrypted FROM provider_keys WHERE id=$1 AND enabled=true`,
      [id],
    );
    if (r.rowCount === 0) throw new Error('provider key not found or disabled');
    return decrypt(r.rows[0].api_key_encrypted);
  },

  async getRow(id: string): Promise<{
    id: string;
    org_id: string;
    provider: string;
    endpoint: string | null;
    region: ProviderRegion | null;
    enabled: boolean;
    protocol: ProviderProtocol;
  } | null> {
    const r = await pool.query(
      `SELECT id, org_id, provider, endpoint, region, enabled, protocol FROM provider_keys WHERE id=$1`,
      [id],
    );
    return (r.rows[0] as never) ?? null;
  },

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await pool.query(`UPDATE provider_keys SET enabled=$1 WHERE id=$2`, [enabled, id]);
  },

  /**
   * Write back the result of a connection probe: `status` (connected|failed),
   * `latencyMs` (round-trip ms), and `lastTestAt` (ISO timestamp).
   * Scoped to `orgId` so callers cannot update rows from another tenant.
   * Returns true when a row was actually updated.
   */
  async updateStatus(
    id: string,
    orgId: string,
    fields: {
      status: 'connected' | 'failed';
      latencyMs: number;
      lastTestAt: string;
    },
  ): Promise<boolean> {
    const r = await pool.query(
      `UPDATE provider_keys SET status = $1, latency_ms = $2, last_test_at = $3
        WHERE id = $4 AND org_id = $5`,
      [fields.status, fields.latencyMs, fields.lastTestAt, id, orgId],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /**
   * Replace the stored API key for a provider row: re-encrypts the plaintext
   * and writes a fresh display mask. The plaintext is never returned by any
   * method; only the `•`-masked form is persisted for display.
   */
  /**
   * Store a new key.
   *
   * Setting the key of a KEYLESS row enables it: `add` creates a keyless
   * provider disabled ("未填写时模型不可调用"), and the doc there says it is
   * "enabled later once a key is set" — without this the console's "tick a
   * capability → type the key → save" flow would leave the section disabled
   * and silently routing nothing. A row that already had a key keeps its own
   * state (the admin may have switched it off deliberately), and a row whose
   * card is switched off stays off (`enabled_before_master` is not NULL).
   */
  async setApiKey(id: string, plaintextKey: string): Promise<void> {
    await pool.query(
      `UPDATE provider_keys
          SET api_key_encrypted = $1,
              api_key_masked = $2,
              enabled = enabled
                        OR (api_key_masked IS NULL AND enabled_before_master IS NULL)
        WHERE id = $3`,
      [encrypt(plaintextKey), maskKey(plaintextKey), id],
    );
  },

  async patch(
    id: string,
    fields: {
      description?: string | null;
      endpoint?: string | null;
      label?: string | null;
      enabled?: boolean;
      protocol?: ProviderProtocol;
      codingPlan?: boolean;
      /** Provider-specific settings. Merged at the TOP level: the incoming
       * keys replace the stored ones, the other stored keys survive. That
       * way a UI that only knows about `models` cannot wipe the ASR daily
       * cap it never saw. */
      config?: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (fields.description !== undefined) {
      sets.push(`description = $${i++}`);
      params.push(fields.description);
    }
    if (fields.endpoint !== undefined) {
      sets.push(`endpoint = $${i++}`);
      params.push(fields.endpoint);
    }
    if (fields.label !== undefined) {
      sets.push(`label = $${i++}`);
      params.push(fields.label);
    }
    if (fields.enabled !== undefined) {
      // An explicit per-section toggle is the admin's own decision: it also
      // ends any master-switch snapshot, so a later card off→on restores
      // from this state rather than from a stale one.
      sets.push(`enabled = $${i++}`);
      sets.push(`enabled_before_master = NULL`);
      params.push(fields.enabled);
    }
    if (fields.protocol !== undefined) {
      sets.push(`protocol = $${i++}`);
      params.push(fields.protocol);
    }
    if (fields.codingPlan !== undefined) {
      sets.push(`coding_plan = $${i++}`);
      params.push(fields.codingPlan);
    }
    if (fields.config !== undefined) {
      sets.push(`config = provider_keys.config || $${i++}::jsonb`);
      params.push(JSON.stringify(fields.config));
    }
    if (sets.length === 0) return true;
    params.push(id);
    const r = await pool.query(
      `UPDATE provider_keys SET ${sets.join(', ')} WHERE id = $${i}`,
      params,
    );
    return (r.rowCount ?? 0) > 0;
  },

  /**
   * Hard-delete a provider_key row, scoped to the caller's org. Returns
   * true when a row was actually removed; false if the row did not exist
   * or belonged to a different org (the route handler turns that into a
   * 404 before it ever gets here, but the abstraction still respects org).
   *
   * Callers are responsible for cascading dependent tables (model_catalog
   * via modelCatalog.deleteByProviderKey) BEFORE invoking remove().
   */
  async remove(orgId: string, id: string): Promise<boolean> {
    const r = await pool.query(
      `DELETE FROM provider_keys WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    return (r.rowCount ?? 0) > 0;
  },
};
