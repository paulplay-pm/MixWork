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

const tokenFor = async (roles: string[]): Promise<string> =>
  signToken({ sub: 'u1', orgId: 'o1', roles });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

interface Scope { allCompany: boolean; deptIds: string[]; userIds: string[] }
const ALL_COMPANY: Scope = { allCompany: true, deptIds: [], userIds: [] };

async function seed(overrides: Array<{ id: string; scope: Scope; enabled?: boolean }>): Promise<void> {
  for (const o of overrides) {
    await testPool.query(
      `INSERT INTO agent_marketplace_agents
         (agent_id, name, scope, enabled, org_id)
       VALUES ($1, $1, $2::jsonb, $3, $4)`,
      [o.id, JSON.stringify(o.scope), o.enabled ?? true, 'o1'],
    );
  }
}

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
});

describe('GET /api/agent-marketplace', () => {
  test('401 without a token', async () => {
    expect((await app.request('/api/agent-marketplace')).status).toBe(401);
  });

  test('returns only the enabled agents the caller scope grants', async () => {
    await seed([
      { id: 'a', scope: ALL_COMPANY },
      { id: 'b', scope: { allCompany: false, deptIds: [], userIds: ['u1'] } },
      { id: 'c', scope: { allCompany: false, deptIds: ['d-other'], userIds: [] } },
      { id: 'd', scope: ALL_COMPANY, enabled: false },
    ]);
    const res = await app.request('/api/agent-marketplace', { headers: auth(await tokenFor(['user'])) });
    const body = await res.json() as { agents: Array<{ agentId: string }> };
    expect(res.status).toBe(200);
    expect(body.agents.map(a => a.agentId)).toEqual(['a', 'b']);
  });

  test('super_admin sees every enabled agent', async () => {
    await seed([{ id: 'a', scope: { allCompany: false, deptIds: ['d'], userIds: [] } }]);
    const res = await app.request('/api/agent-marketplace', { headers: auth(await tokenFor(['super_admin'])) });
    const body = await res.json() as { agents: Array<{ agentId: string }> };
    expect(body.agents.map(a => a.agentId)).toEqual(['a']);
  });
});
