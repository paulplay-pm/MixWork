import { pool } from '../db/pool';

/** Why the selection landed on the model it did. */
export const ModelSelectionReason = {
  /** The client named the model and it matched exactly one row. */
  Explicit: 'explicit',
  /** The client named a bare model that several vendors publish. */
  AmbiguousFallback: 'ambiguous_fallback',
  /** The client named a model no enabled row carries. */
  NotFoundFallback: 'not_found_fallback',
  /** The client named no model; the type's default was used. */
  Default: 'default',
} as const;
export type ModelSelectionReason = (typeof ModelSelectionReason)[keyof typeof ModelSelectionReason];

export interface TypedModelCandidate {
  /** `model_catalog.id`. */
  id: string;
  /** The bare upstream model name. */
  model: string;
  /** `<prefix>/<model>` — the client-facing identity. */
  qualifiedId: string;
  /** The prefix half of `qualifiedId`. */
  providerPrefix: string;
  /** The `provider_keys` row that owns the model. */
  providerKeyId: string;
  /** The owning key's provider slug. */
  provider: string;
  displayName: string | null;
  types: string[];
  parameterSpec: Record<string, unknown>;
}

export interface TypedModelSelection {
  candidate: TypedModelCandidate;
  reason: ModelSelectionReason;
}

interface CandidateRow {
  id: string;
  model: string;
  display_name: string | null;
  types: string[] | null;
  parameter_spec: Record<string, unknown> | null;
  provider_key_id: string;
  provider: string;
  provider_prefix: string;
}

/**
 * The prefix half of a qualified id, sanitised so it cannot contain the
 * separator: the prefix is everything before the FIRST `/`, so a `/` inside
 * it would be read back as the separator.
 */
function sanitizePrefix(prefix: string): string {
  return prefix.replace(/\//g, '_');
}

function toCandidate(row: CandidateRow): TypedModelCandidate {
  const providerPrefix = sanitizePrefix(row.provider_prefix);
  return {
    id: row.id,
    model: row.model,
    qualifiedId: `${providerPrefix}/${row.model}`,
    providerPrefix,
    providerKeyId: row.provider_key_id,
    provider: row.provider,
    displayName: row.display_name,
    types: row.types ?? [],
    parameterSpec: row.parameter_spec ?? {},
  };
}

/**
 * The one place that answers "which model runs this request".
 *
 * A candidate is a model row that is actually usable right now: the model is
 * enabled, its provider key is enabled (a disabled key is an org-wide off
 * switch), and the org policy has not disabled it. The order is
 * `created_at ASC, id ASC` — a total order, so "the first enabled model" is
 * deterministic rather than whatever the planner returns first.
 *
 * A model is addressed by its QUALIFIED id, `<prefix>/<model>`, where the
 * prefix is the vendor card's display label (or the slug). A client may also
 * send the bare model name; that is accepted when exactly one candidate
 * carries it. A bare name containing `/` cannot be expressed — the part
 * before the first `/` is always read as a prefix.
 */
export const typedModelSelection = {
  /** Every enabled model of `type` in the org, in `created_at ASC, id ASC` order. */
  async listCandidates(orgId: string, type: string): Promise<TypedModelCandidate[]> {
    const r = await pool.query<CandidateRow>(
      `SELECT c.id, c.model, c.display_name, c.types, c.parameter_spec,
              c.provider_key_id,
              k.provider AS provider,
              COALESCE(pc.label, pc.provider, k.provider) AS provider_prefix
         FROM model_catalog c
         JOIN provider_keys k ON k.id = c.provider_key_id AND k.org_id = c.org_id
         LEFT JOIN provider_cards pc ON pc.id = k.card_id
         LEFT JOIN model_policies p ON p.org_id = c.org_id AND p.model_id = c.id
        WHERE c.org_id = $1
          AND c.enabled
          AND k.enabled
          AND COALESCE(p.disabled, false) = false
          AND c.types && $2::text[]
        ORDER BY c.created_at ASC, c.id ASC`,
      [orgId, [type]],
    );
    return r.rows.map(toCandidate);
  },

  /** The org's default model for `type`, or null when there is none (or it is
   * not currently usable — a disabled default is not a default). */
  async defaultCandidate(orgId: string, type: string): Promise<TypedModelCandidate | null> {
    const r = await pool.query<{ model_id: string }>(
      `SELECT model_id FROM model_type_defaults WHERE org_id = $1 AND type = $2`,
      [orgId, type],
    );
    const modelId = r.rows[0]?.model_id;
    if (!modelId) return null;
    const candidates = await typedModelSelection.listCandidates(orgId, type);
    return candidates.find((c) => c.id === modelId) ?? null;
  },

  /**
   * Resolve a requested model name to a row. `requested` may be empty.
   *
   * The chain is fixed: an exact match wins; a bare name carried by exactly
   * one candidate is an exact match; an ambiguous or unknown name falls back
   * to the type's default and then to the first enabled candidate. It never
   * throws on a bad name — a bad name is a fallback, not a server error.
   */
  async select(
    orgId: string,
    type: string,
    requested?: string | null,
  ): Promise<TypedModelSelection | null> {
    const candidates = await typedModelSelection.listCandidates(orgId, type);
    if (candidates.length === 0) return null;

    const wanted = (requested ?? '').trim();
    let reason: ModelSelectionReason = ModelSelectionReason.Default;

    if (wanted) {
      const exact = candidates.find((c) => c.qualifiedId === wanted);
      if (exact) return { candidate: exact, reason: ModelSelectionReason.Explicit };

      // The bare part is everything after the FIRST `/`, so a model name that
      // itself contains `/` survives a round-trip of its qualified id.
      const bare = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted;
      const byBare = candidates.filter((c) => c.model === bare);
      if (byBare.length === 1) {
        return { candidate: byBare[0], reason: ModelSelectionReason.Explicit };
      }
      reason =
        byBare.length > 1
          ? ModelSelectionReason.AmbiguousFallback
          : ModelSelectionReason.NotFoundFallback;
    }

    const fallback =
      (await typedModelSelection.defaultCandidate(orgId, type)) ?? candidates[0];
    return { candidate: fallback, reason };
  },
};
