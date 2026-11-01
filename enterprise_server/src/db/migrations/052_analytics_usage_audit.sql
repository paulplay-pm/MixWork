-- enterprise_server/src/db/migrations/052_analytics_usage_audit.sql
-- Migration 052: analytics (运行分析) support.
--
-- 1. usage_missing marks calls whose upstream response carried no parsable
--    `usage`. Every such call is still counted in call_count; the analytics
--    pages surface the aggregate as `unaccounted_calls` so tokens are never
--    silently understated (spec D10). NOT NULL DEFAULT false so pre-existing
--    rows read as a definite "usage was present" rather than an unknown.
-- 2. stream_usage_supported is the per-provider-key memory for "does this
--    OpenAI-compatible endpoint accept stream_options.include_usage".
--    NULL means untried; false means a rejection that IMPLICATED the field, so
--    the proxy stops paying a failed round-trip per streaming request (D9).
--    Deliberately nullable with no default: a later task writes the probe
--    result, and "never probed" must stay distinguishable from "probed and
--    rejected". The distinction also has to survive the retest: a rejection
--    that says nothing about stream_options (OpenAI returns 400 for
--    context_length_exceeded too) must leave the column NULL so the next
--    request re-probes, because there is no admin route or TTL to undo a wrong
--    downgrade.
-- 3. Indexes: the analytics pages slice by ts (not quota_window_date), and
--    the audit list filters action alongside ts. The pre-existing
--    (org_id, quota_window_date) indexes cannot serve those access paths.
-- 4. Role grants: BUILTIN_ROLE_POINTS in src/shared/permissionPoints.ts only
--    feeds the one-shot INSERT in 029_seed_roles_v2.sql, while runtime
--    enforcement resolves points from roles.permissions in Postgres. Without
--    this UPDATE an already-deployed database never receives usage:view /
--    usage:export. Same idempotent shape as migration 037.
-- Idempotent for pglite test replay.

ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS usage_missing BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS stream_usage_supported BOOLEAN;

CREATE INDEX IF NOT EXISTS token_usage_org_ts ON token_usage(org_id, ts);
CREATE INDEX IF NOT EXISTS audit_events_org_ts_action ON audit_events(org_id, ts DESC, action);

UPDATE roles
SET permissions = permissions || '["usage:view","usage:export"]'::jsonb
WHERE name IN ('super_admin','auditor','org_admin')
  AND NOT (permissions @> '["usage:view"]'::jsonb);
