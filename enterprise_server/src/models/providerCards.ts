import { createHash, randomUUID } from 'node:crypto';

import { pool } from '../db/pool';
import type { ProviderProtocol } from '../vault/providerKeyVault';

/**
 * One capability section of a vendor card.
 *
 * A section IS a `provider_keys` row: one credential, one upstream wire
 * protocol, one Base URL. The card is the grouping around those rows.
 */
export interface ProviderCardSection {
  providerKeyId: string;
  protocol: ProviderProtocol;
  endpoint: string | null;
  label: string | null;
  enabled: boolean;
  /** A built-in credential row: it cannot be deleted, only disabled. */
  isBuiltin: boolean;
  codingPlan: boolean;
  apiKeyMasked: string | null;
  /** How many models this section's model table shows. */
  modelCount: number;
}

/** One vendor card: a vendor plus its capability sections. */
export interface ProviderCardView {
  id: string;
  /** The vendor slug ('minimax'). */
  provider: string;
  /** The card's display name; null → the console falls back to the slug. */
  label: string | null;
  createdAt: string;
  /** True when any section of the card is a built-in credential row. */
  isBuiltin: boolean;
  /** The card's master switch: on when at least one section is enabled. */
  enabled: boolean;
  sections: ProviderCardSection[];
}

/** The order a card's sections are listed in: chat first, then the media
 * adapters, in the order the console's capability chips offer them. */
const PROTOCOL_ORDER: ProviderProtocol[] = [
  'openai',
  'anthropic',
  'realtime-asr',
  'image-gen',
  'video-gen',
];

function protocolRank(protocol: string): number {
  const i = PROTOCOL_ORDER.indexOf(protocol as ProviderProtocol);
  return i === -1 ? PROTOCOL_ORDER.length : i;
}

/** The deterministic id of the card that owns slot `slot` of a vendor group.
 *  The same expression the 058 backfill uses, so a key added at runtime
 *  lands on the same card the backfill would have given it. */
export function cardIdForSlot(orgId: string, provider: string, slot: number): string {
  return `card:${createHash('md5').update(`${orgId}:${provider}:${slot}`).digest('hex')}`;
}

/** The qualified-name prefix of a card: the label, or the slug when unset. */
export function cardPrefix(label: string | null, provider: string): string {
  return label ?? provider;
}

interface CardRow {
  id: string;
  provider: string;
  label: string | null;
  created_at: Date;
}

interface SectionRow {
  card_id: string;
  id: string;
  protocol: string;
  endpoint: string | null;
  label: string | null;
  enabled: boolean;
  is_builtin: boolean;
  coding_plan: boolean;
  api_key_masked: string | null;
}

export const providerCards = {
  /** Every card of the org, each with its sections. */
  async list(orgId: string): Promise<ProviderCardView[]> {
    const cards = await pool.query<CardRow>(
      `SELECT id, provider, label, created_at
         FROM provider_cards
        WHERE org_id = $1
        ORDER BY provider ASC, label ASC NULLS FIRST, created_at ASC`,
      [orgId],
    );
    if (cards.rowCount === 0) return [];

    const cardIds = cards.rows.map((c) => c.id);
    const sections = await pool.query<SectionRow>(
      `SELECT card_id, id, protocol, endpoint, label, enabled, is_builtin, coding_plan, api_key_masked
         FROM provider_keys
        WHERE org_id = $1 AND card_id = ANY($2::text[])
        ORDER BY card_id ASC, id ASC`,
      [orgId, cardIds],
    );
    const counts = await pool.query<{ provider_key_id: string; n: number }>(
      `SELECT provider_key_id, count(*)::int AS n
         FROM model_catalog
        WHERE org_id = $1
        GROUP BY provider_key_id`,
      [orgId],
    );
    const modelCountByKey = new Map(counts.rows.map((r) => [r.provider_key_id, r.n]));

    const sectionsByCard = new Map<string, ProviderCardSection[]>();
    for (const s of sections.rows) {
      const list = sectionsByCard.get(s.card_id) ?? [];
      list.push({
        providerKeyId: s.id,
        protocol: s.protocol as ProviderProtocol,
        endpoint: s.endpoint,
        label: s.label,
        enabled: s.enabled,
        isBuiltin: s.is_builtin,
        codingPlan: s.coding_plan,
        apiKeyMasked: s.api_key_masked,
        modelCount: modelCountByKey.get(s.id) ?? 0,
      });
      sectionsByCard.set(s.card_id, list);
    }

    return cards.rows.map((c) => {
      const own = (sectionsByCard.get(c.id) ?? []).sort(
        (a, b) => protocolRank(a.protocol) - protocolRank(b.protocol),
      );
      return {
        id: c.id,
        provider: c.provider,
        label: c.label,
        createdAt: c.created_at.toISOString(),
        isBuiltin: own.some((s) => s.isBuiltin),
        enabled: own.some((s) => s.enabled),
        sections: own,
      };
    });
  },

  /** One card, or null when it does not belong to the org. */
  async getById(orgId: string, id: string): Promise<ProviderCardView | null> {
    const all = await providerCards.list(orgId);
    return all.find((c) => c.id === id) ?? null;
  },

  /**
   * A new card for a vendor.
   *
   * The card's PREFIX (`label ?? provider`) is unique per org — it is the
   * `<prefix>/<model>` namespace the media wire format addresses models in.
   * A second card for the same vendor therefore needs a different label.
   */
  async create(input: {
    orgId: string;
    provider: string;
    label?: string;
    createdBy?: string;
  }): Promise<{ id: string }> {
    const id = `card:${randomUUID()}`;
    try {
      await pool.query(
        `INSERT INTO provider_cards (id, org_id, provider, label, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [id, input.orgId, input.provider, input.label ?? null, input.createdBy ?? null],
      );
    } catch (err) {
      // 23505 = unique_violation: the prefix is taken.
      if ((err as { code?: string }).code === '23505') {
        throw new Error('card_duplicate');
      }
      throw err;
    }
    return { id };
  },

  /**
   * Update a card.
   *
   * `enabled: false` switches the whole card off — every section is disabled,
   * and its own state is snapshotted in `enabled_before_master`. `enabled:
   * true` restores that snapshot: a section the admin had switched off stays
   * off, and a keyless one never comes back on (it cannot authenticate, so
   * enabling it would publish a broken credential).
   */
  async patch(
    orgId: string,
    id: string,
    fields: { label?: string | null; enabled?: boolean },
  ): Promise<boolean> {
    if (fields.label !== undefined) {
      try {
        const r = await pool.query(
          `UPDATE provider_cards SET label = $3 WHERE id = $1 AND org_id = $2`,
          [id, orgId, fields.label],
        );
        if (r.rowCount === 0) return false;
      } catch (err) {
        // 23505 = unique_violation on the per-org prefix: another card of this
        // org already owns `COALESCE(label, provider)`.
        if ((err as { code?: string }).code === '23505') {
          throw new Error('card_duplicate');
        }
        throw err;
      }
    }
    if (fields.enabled !== undefined) {
      if (!fields.enabled) {
        // Remember each section's own state (only on the first switch-off: a
        // second "off" must not overwrite the snapshot with `false`).
        await pool.query(
          `UPDATE provider_keys
              SET enabled_before_master = COALESCE(enabled_before_master, enabled),
                  enabled = false
            WHERE card_id = $1 AND org_id = $2`,
          [id, orgId],
        );
      } else {
        await pool.query(
          `UPDATE provider_keys
              SET enabled = COALESCE(enabled_before_master, false)
                            AND api_key_masked IS NOT NULL,
                  enabled_before_master = NULL
            WHERE card_id = $1 AND org_id = $2`,
          [id, orgId],
        );
      }
    }
    return true;
  },

  /**
   * Delete a card and everything under it.
   *
   * The models go first: `model_catalog.provider_key_id` has no ON DELETE
   * CASCADE, so deleting the keys first would leave orphaned rows. The
   * per-type default pointers cascade from the models
   * (`model_type_defaults.model_id` is ON DELETE CASCADE).
   */
  async remove(
    orgId: string,
    id: string,
  ): Promise<{ deletedKeys: number; deletedModels: number }> {
    const keyIds = await pool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE card_id = $1 AND org_id = $2`,
      [id, orgId],
    );
    const ids = keyIds.rows.map((r) => r.id);
    let deletedModels = 0;
    let deletedKeys = 0;
    if (ids.length > 0) {
      const models = await pool.query(
        `DELETE FROM model_catalog WHERE provider_key_id = ANY($1::text[]) AND org_id = $2`,
        [ids, orgId],
      );
      deletedModels = models.rowCount ?? 0;
      const keys = await pool.query(
        `DELETE FROM provider_keys WHERE id = ANY($1::text[]) AND org_id = $2`,
        [ids, orgId],
      );
      deletedKeys = keys.rowCount ?? 0;
    }
    await pool.query(`DELETE FROM provider_cards WHERE id = $1 AND org_id = $2`, [id, orgId]);
    return { deletedKeys, deletedModels };
  },
};
