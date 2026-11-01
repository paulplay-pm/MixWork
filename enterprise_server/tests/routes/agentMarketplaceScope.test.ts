// Route tests for the department-based visibility of the agent catalog.
//
// The catalog moved from a role grant (`allowed_roles`) to the same scope
// shape the skill marketplace uses (migration 038): a JSONB
// `{allCompany, deptIds, userIds}` grant. Visibility is: super_admin sees
// every enabled agent; otherwise an agent is visible iff its scope is
// `allCompany`, the caller is a member exception (`userIds`), or the caller's
// OWN (leaf) dept intersects the GRANTED `scope.deptIds` expanded to its
// subtree (grant parent → child sees it). `enabled=false` is never served.
//
// Auth is JWT-claim-only (requireAuth never looks users up), but
// `scopeApi.deptIdsFor` DOES join `user_departments`→`users`, so the seed
// creates real org / department (with `path`) / user / membership rows.
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { agentMarketplaceRoutes } from '../../src/routes/agentMarketplace';

const app = new Hono();
app.route('/', agentMarketplaceRoutes);

interface Scope { allCompany: boolean; deptIds: string[]; userIds: string[] }

const tokenFor = (sub: string, roles: string[] = ['user']): Promise<string> =>
  signToken({ sub, orgId: 'o1', roles });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function mkAgent(id: string, scope: Scope, enabled = true): Promise<void> {
  await testPool.query(
    `INSERT INTO agent_marketplace_agents (agent_id, name, scope, enabled, org_id)
     VALUES ($1, $1, $2::jsonb, $3, 'o1')`,
    [id, JSON.stringify(scope), enabled],
  );
}

/** Minimal org + dept tree + users + memberships.
 * Dept paths drive the subtree expansion:
 *   rd   -> /rd        (parent)
 *   fe   -> /rd/fe     (child of rd)
 *   sales-> /sales     (unrelated) */
async function seed(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1')`);
  await testPool.query(
    `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES
       ('rd',    'o1', '研发', NULL, '/rd'),
       ('fe',    'o1', '前端', 'rd',   '/rd/fe'),
       ('sales', 'o1', '销售', NULL,   '/sales')`,
  );
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, display_name) VALUES
       ('u2',    'o1', 'u2',    'x', 'U2'),
       ('u3',    'o1', 'u3',    'x', 'U3'),
       ('admin', 'o1', 'admin', 'x', 'Admin')`,
  );
  await testPool.query(
    `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES
       ('u2', 'fe', true),
       ('u3', 'sales', true)`,
  );

  // a-rd: granted to PARENT dept `rd` — the key subtree case.
  await mkAgent('a-rd', { allCompany: false, deptIds: ['rd'], userIds: [] });
  // a-all: whole-company.
  await mkAgent('a-all', { allCompany: true, deptIds: [], userIds: [] });
  // a-u2: member exception for u2 only.
  await mkAgent('a-u2', { allCompany: false, deptIds: [], userIds: ['u2'] });
  // a-sales: granted to a sibling dept — must NOT leak to u2 (in fe/rd).
  await mkAgent('a-sales', { allCompany: false, deptIds: ['sales'], userIds: [] });
  // a-none: no grant at all — nobody but a super admin sees it.
  await mkAgent('a-none', { allCompany: false, deptIds: [], userIds: [] });
  // a-off: disabled — never served.
  await mkAgent('a-off', { allCompany: true, deptIds: [], userIds: [] }, false);
}

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await seed();
});

const listIds = async (token: string): Promise<string[]> => {
  const res = await app.request('/api/agent-marketplace', { headers: auth(token) });
  expect(res.status).toBe(200);
  const body = await res.json() as { agents: Array<{ agentId: string }> };
  return body.agents.map(a => a.agentId).sort();
};

describe('GET /api/agent-marketplace (department scope)', () => {
  test('401 without a token', async () => {
    expect((await app.request('/api/agent-marketplace')).status).toBe(401);
  });

  test('a dept member sees the agents granted to their dept tree', async () => {
    // u2 sits in `fe`, a child of `rd`: the `rd` grant reaches them, and the
    // member exception names them outright.
    expect(await listIds(await tokenFor('u2'))).toEqual(['a-all', 'a-rd', 'a-u2']);
  });

  test('a dept member does NOT see agents granted to another dept', async () => {
    const ids = await listIds(await tokenFor('u2'));
    expect(ids).not.toContain('a-sales');
    expect(ids).not.toContain('a-none');
  });

  test('a user in another dept sees only what is granted to them', async () => {
    expect(await listIds(await tokenFor('u3'))).toEqual(['a-all', 'a-sales']);
  });

  test('a caller with no department sees only whole-company grants', async () => {
    expect(await listIds(await tokenFor('nobody'))).toEqual(['a-all']);
  });

  test('super_admin sees every enabled agent', async () => {
    expect(await listIds(await tokenFor('admin', ['super_admin']))).toEqual([
      'a-all', 'a-none', 'a-rd', 'a-sales', 'a-u2',
    ]);
  });

  test('disabled agents are never served', async () => {
    const ids = await listIds(await tokenFor('admin', ['super_admin']));
    expect(ids).not.toContain('a-off');
  });

  test('the response carries the scope, not the retired role list', async () => {
    const res = await app.request('/api/agent-marketplace', {
      headers: auth(await tokenFor('admin', ['super_admin'])),
    });
    const body = await res.json() as { agents: Array<Record<string, unknown>> };
    const a = body.agents.find(x => x.agentId === 'a-rd');
    expect(a?.scope).toEqual({ allCompany: false, deptIds: ['rd'], userIds: [] });
    expect(a).not.toHaveProperty('allowedRoles');
  });

  test('agents of another org are never served', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'T2')`);
    await testPool.query(
      `INSERT INTO agent_marketplace_agents (agent_id, name, scope, enabled, org_id)
       VALUES ('a-other', 'Other', '{"allCompany":true,"deptIds":[],"userIds":[]}'::jsonb, TRUE, 'o2')`,
    );
    const ids = await listIds(await tokenFor('admin', ['super_admin']));
    expect(ids).not.toContain('a-other');
  });
});
