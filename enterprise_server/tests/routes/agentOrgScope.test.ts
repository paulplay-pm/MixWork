import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import type { AgentMarketplaceView } from '../../src/models/agentMarketplaceView';
import { agentMarketplaceRoutes } from '../../src/routes/agentMarketplace';
import { agentMarketplaceAdminRoutes } from '../../src/routes/agentMarketplaceAdmin';

async function org(id: string): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [id]);
}

/** An agent row inserted the way the route does, owned by `owner`. */
async function agent(agentId: string, owner: string): Promise<void> {
  await testPool.query(
    `INSERT INTO agent_marketplace_agents(agent_id, name, org_id, scope)
     VALUES ($1,$1,$2,'{"allCompany":true,"deptIds":[],"userIds":[]}'::jsonb)`,
    [agentId, owner]
  );
}

function app() {
  const a = new Hono();
  a.route('/', agentMarketplaceAdminRoutes);
  a.route('/', agentMarketplaceRoutes);
  return a;
}

const tok = (orgId: string) => signToken({ sub: `u-${orgId}`, orgId, roles: ['super_admin'] });

describe('agent catalog is org-scoped', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await org('o1');
    await org('o2');
  });

  test('the admin list returns only the caller org agents', async () => {
    await agent('a1', 'o1');
    await agent('a2', 'o2');
    const res = await app().request('/api/admin/agent-marketplace/agents', {
      headers: { authorization: `Bearer ${await tok('o1')}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentMarketplaceView[];
    expect(body.map((a) => a.agentId)).toEqual(['a1']);
  });

  test('the public catalog returns only the caller org enabled agents', async () => {
    await agent('a1', 'o1');
    await agent('a2', 'o2');
    const res = await app().request('/api/agent-marketplace', {
      headers: { authorization: `Bearer ${await tok('o2')}` },
    });
    const body = (await res.json()) as { agents: AgentMarketplaceView[] };
    expect(body.agents.map((a) => a.agentId)).toEqual(['a2']);
  });

  test('PATCH on another org agent is a 404, not a silent edit', async () => {
    await agent('a2', 'o2');
    const res = await app().request('/api/admin/agent-marketplace/agents/a2', {
      method: 'PUT',
      headers: { authorization: `Bearer ${await tok('o1')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(res.status).toBe(404);
    const row = await testPool.query<{ name: string }>(
      `SELECT name FROM agent_marketplace_agents WHERE agent_id='a2'`
    );
    expect(row.rows[0].name).toBe('a2');
  });

  test('DELETE on another org agent is a 404 and the row survives', async () => {
    await agent('a2', 'o2');
    const res = await app().request('/api/admin/agent-marketplace/agents/a2', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await tok('o1')}` },
    });
    expect(res.status).toBe(404);
    const row = await testPool.query(`SELECT 1 FROM agent_marketplace_agents WHERE agent_id='a2'`);
    expect(row.rowCount).toBe(1);
  });

  test('references of another org agent are not visible', async () => {
    await agent('a2', 'o2');
    const res = await app().request('/api/admin/agent-marketplace/agents/a2/references', {
      headers: { authorization: `Bearer ${await tok('o1')}` },
    });
    expect(res.status).toBe(404);
  });

  test('subagent validation only accepts same-org agents', async () => {
    await agent('a1', 'o1');
    await agent('a2', 'o2');
    const foreign = await app().request('/api/admin/agent-marketplace/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tok('o1')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', scope: { allCompany: true, deptIds: [], userIds: [] }, subagent_allow_agent_ids: ['a2'] }),
    });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ error: 'unknown_subagent' });
  });

  test('a burst of creates yields distinct ids and no 500s', async () => {
    // `agent_<epoch-ms>` is the PRIMARY KEY, so two admins creating inside one
    // millisecond collide and the loser gets a 500. A burst is what a real
    // onboarding does; with a millisecond clock it reproduces reliably where a
    // single pair does not.
    const BURST = 40;
    const ids: string[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < BURST; i++) {
      const res = await app().request('/api/admin/agent-marketplace/agents', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await tok('o1')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: `burst-${i}`, scope: { allCompany: true, deptIds: [], userIds: [] } }),
      });
      statuses.push(res.status);
      if (res.status === 200) ids.push(((await res.json()) as { agent_id: string }).agent_id);
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    expect(new Set(ids).size).toBe(BURST);
  });

  test('a created agent is owned by the creating org', async () => {
    const res = await app().request('/api/admin/agent-marketplace/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tok('o1')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'made-in-o1', scope: { allCompany: true, deptIds: [], userIds: [] } }),
    });
    expect(res.status).toBe(200);
    const { agent_id } = (await res.json()) as { agent_id: string };
    const row = await testPool.query<{ org_id: string }>(
      `SELECT org_id FROM agent_marketplace_agents WHERE agent_id=$1`,
      [agent_id]
    );
    expect(row.rows[0].org_id).toBe('o1');
  });
});