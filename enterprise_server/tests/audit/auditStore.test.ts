import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { auditStore } from '../../src/audit/auditStore';
import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';

// `auditStore` is write-only. Its reader (`auditStore.query`) went away with
// the legacy `GET /admin/audit?format=csv` branch it existed for; every read of
// the audit trail now goes through `src/analytics/auditQuery.ts`, which is
// covered by tests/analytics/auditList.test.ts. These two tests therefore read
// back through SQL — the assertion is still "write put the right row in the
// table", and `write` is what ~100 call sites across SSO, the proxy, the admin
// routes and MCP depend on.
interface Row {
  action: string;
  payload: unknown;
}

async function rows(): Promise<Row[]> {
  const r = await testPool.query<Row>(`SELECT action, payload FROM audit_events WHERE org_id='o1' ORDER BY id`);
  return r.rows;
}

describe('audit/auditStore', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  });

  test('write', async () => {
    await auditStore.write({ orgId: 'o1', userId: 'u1', action: 'login' });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.action).toBe('login');
  });

  test('payload JSON 序列化', async () => {
    await auditStore.write({
      orgId: 'o1',
      userId: 'u1',
      action: 'mcp_call',
      payload: { args: ['a', 'b'] },
    });
    const r = await rows();
    expect(r[0]!.payload).toEqual({ args: ['a', 'b'] });
  });

  test('an omitted payload is stored as NULL, not the string undefined', async () => {
    // `write` is called on dozens of auth/SSO paths with no payload at all. A
    // row carrying the four characters `undefined` would render as a payload
    // in the audit export, and NULL is what every reader branches on.
    await auditStore.write({ orgId: 'o1', userId: 'u1', action: 'login' });
    const r = await testPool.query<{ payload: unknown }>(`SELECT payload FROM audit_events WHERE org_id='o1'`);
    expect(r.rows[0]!.payload).toBeNull();
  });
});
