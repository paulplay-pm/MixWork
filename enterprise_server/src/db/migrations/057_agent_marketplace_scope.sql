-- Migration 057: department-based visibility for the enterprise agent catalog.
--
-- The catalog was granted by ROLE (`allowed_roles JSONB NOT NULL DEFAULT
-- '["org_admin"]'`, migration 025): an agent was visible to whoever held one of
-- the listed roles. That model cannot express "the 风控 agent is for the risk
-- department" — a role is a job, not a group of people — and it is the reason
-- every user with the same role saw the same agents.
--
-- This replaces it with the SAME scope shape the skill marketplace uses
-- (migration 038): a JSONB grant
--   {allCompany: boolean, deptIds: string[], userIds: string[]}
-- evaluated exactly like the skill/connector scope — super_admin sees
-- everything; otherwise the agent is visible when the scope names the whole
-- company, names the caller as a member exception, or names a department the
-- caller belongs to (or a department above them: a grant on a parent covers
-- its whole subtree).
--
-- Backfill: existing rows keep the DEFAULT empty scope, which grants access
-- to super_admins only. This is deliberate and it is the safe direction:
--   * the live V1 deployment's only agent was granted `["super_admin"]`, and
--     a super admin sees everything regardless of the scope, so its audience
--     is unchanged;
--   * a role grant can never be WIDENED by this migration — an agent that a
--     whole role used to see now needs an explicit department grant, and the
--     admin re-scopes it in the 可见范围 tab.
-- (Migration 035's connector migration made the opposite choice — backfill to
-- allCompany — because its legacy rows were role-gated too. Tightening is the
-- right default for a catalog of company-confidential agents.)
--
-- `allowed_roles` is dropped, as migration 038 dropped it for skills: the
-- role grant is replaced, not kept alongside.
--
-- Re-run safe (the test harness re-runs every file with no ledger check):
-- both statements are guarded with IF NOT EXISTS / IF EXISTS.

ALTER TABLE agent_marketplace_agents
  ADD COLUMN IF NOT EXISTS scope JSONB NOT NULL
  DEFAULT '{"allCompany":false,"deptIds":[],"userIds":[]}'::jsonb;

ALTER TABLE agent_marketplace_agents DROP COLUMN IF EXISTS allowed_roles;
