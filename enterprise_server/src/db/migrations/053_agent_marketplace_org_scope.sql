-- Migration 053: make the enterprise agent catalog org-scoped.
--
-- `agent_marketplace_agents` (migration 025) is the ONLY catalog in this
-- codebase without an `org_id`: `kit_catalog` (040) and
-- `skill_marketplace_skills` (038) are both org-scoped, and the MCP connector
-- table (035) was given one for the same reason. Agents predate that work and
-- were missed, which meant every org admin could read, edit and DELETE every
-- other org's agents — the admin list was an unqualified
-- `SELECT ... FROM agent_marketplace_agents ORDER BY created_at DESC`.
--
-- Legacy rows are attributed to the OLDEST org, following migration 035's
-- precedent: V1 is single-tenant (one org per deployment), and the first org
-- is created at setup time with a random id, so there is no other defensible
-- owner. On a fresh install with no org the CROSS JOIN yields zero rows and
-- this is a clean no-op.
--
-- `agent_id` stays a global PRIMARY KEY. It is generated as `agent_<epoch-ms>`
-- and is referenced by `subagent_allow_agent_ids`, kit definitions and the
-- desktop client; re-keying it on (org_id, agent_id) would ripple through all
-- of them for a collision that a millisecond timestamp makes vanishingly
-- unlikely. This mirrors `mcp_connectors`, which is likewise `id TEXT PRIMARY
-- KEY` plus a scoping `org_id`.
--
-- Re-run safe for pglite test replay: ADD COLUMN IF NOT EXISTS, guarded UPDATE,
-- and the NOT NULL is only applied once the backfill has had a chance to run.

ALTER TABLE agent_marketplace_agents ADD COLUMN IF NOT EXISTS org_id TEXT;

UPDATE agent_marketplace_agents a
   SET org_id = o.id
  FROM (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1) o
 WHERE a.org_id IS NULL;

-- Any row still NULL here belongs to an install with no org at all (an agent
-- created outside a tenant, or a pre-setup fixture). Give it an empty owner
-- rather than failing the migration: an orphaned agent is invisible to every
-- org, which is the correct outcome for a row nobody owns.
UPDATE agent_marketplace_agents SET org_id = '' WHERE org_id IS NULL;

ALTER TABLE agent_marketplace_agents ALTER COLUMN org_id SET NOT NULL;

-- The admin list is `ORDER BY created_at DESC` and is served on every page
-- load; without this it degrades to a sequential scan of the whole table once
-- the catalog grows.
CREATE INDEX IF NOT EXISTS agent_marketplace_agents_org_idx
  ON agent_marketplace_agents (org_id, created_at DESC);