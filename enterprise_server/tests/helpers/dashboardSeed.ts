/**
 * Row builders for the dashboard aggregation tests.
 *
 * They live here rather than in either test file because the summary and usage
 * suites seed the same org, and a second copy of `mcp()` / `dept()` is a second
 * place for the `path` rule or a NOT NULL column to drift out of sync with the
 * other — a fixture that satisfies one suite and not the other reads as a
 * product bug when it is a helper bug.
 *
 * All of them write through the mocked pglite pool, so the same code runs in
 * production (pg) and in tests without a branch.
 */
import { testPool } from '../../src/db/testDb';

export async function seedOrg(timezone = 'UTC'): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1','T',$1)`, [timezone]);
}

/** `password_hash` is NOT NULL but never read by these suites; 'x' is a
 *  placeholder, not a hash, and nothing here authenticates. */
export async function user(
  id: string,
  opts: { status?: string; deptId?: string | null } = {}
): Promise<void> {
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, display_name, department_id, status)
     VALUES ($1,'o1',$2,'x',$3,$4,$5)`,
    [id, id, `n${id}`, opts.deptId ?? null, opts.status ?? 'active']
  );
}

/** Mirrors `orgService.createDept`'s path rule: `/name`, and a child's path is
 *  its parent's plus `/name`. The dept roll-up query reads that column. */
export async function dept(id: string, name: string, parentId: string | null): Promise<void> {
  const parent = parentId
    ? (
        await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id=$1`, [parentId])
      ).rows[0]?.path
    : null;
  await testPool.query(
    `INSERT INTO departments(id, org_id, name, parent_id, path, code)
     VALUES ($1,'o1',$2,$3,$4,$5)`,
    [id, name, parentId, parent ? `${parent}/${name}` : `/${name}`, id]
  );
}

export interface McpOpts {
  enabled?: boolean;
  status?: string | null;
  latency?: number | null;
  testedAt?: string | null;
  zh?: string | null;
  en?: string | null;
}

export async function mcp(id: string, opts: McpOpts = {}): Promise<void> {
  await testPool.query(
    `INSERT INTO mcp_connectors(id, org_id, server_key, name_zh, name_en, url, enabled,
                                 last_test_at, last_test_status, last_latency_ms)
     VALUES ($1,'o1',$1,$2,$3,'https://x',$4,$5,$6,$7)`,
    [
      id,
      opts.zh ?? null,
      opts.en ?? null,
      opts.enabled ?? true,
      opts.testedAt ?? null,
      opts.status ?? null,
      opts.latency ?? null,
    ]
  );
}

export interface PkOpts {
  enabled?: boolean;
  status?: string;
  latency?: number | null;
  testedAt?: string | null;
  label?: string | null;
  provider?: string;
}

export async function providerKey(id: string, opts: PkOpts = {}): Promise<void> {
  await testPool.query(
    `INSERT INTO provider_keys(id, org_id, provider, endpoint, label, enabled,
                                status, latency_ms, last_test_at)
     VALUES ($1,'o1',$2,'https://x',$3,$4,$5,$6,$7)`,
    [
      id,
      opts.provider ?? id,
      opts.label ?? null,
      opts.enabled ?? true,
      opts.status ?? 'unknown',
      opts.latency ?? null,
      opts.testedAt ?? null,
    ]
  );
}

export async function agent(id: string, enabled: boolean, orgId = 'o1'): Promise<void> {
  await testPool.query(
    `INSERT INTO agent_marketplace_agents(agent_id, name, enabled, org_id) VALUES ($1,$1,$2,$3)`,
    [id, enabled, orgId]
  );
}

/** `model_catalog` needs a `provider_keys` row first (FK), and `token_usage`
 *  needs a `model_catalog` row first. Both are NOT NULL with no cascade, so the
 *  chain has to be built in that order by every caller that needs usage. */
export async function providerKeyWithModel(
  keyId: string,
  modelId: string,
  opts: { model?: string; provider?: string; displayName?: string } = {}
): Promise<void> {
  await providerKey(keyId, { provider: opts.provider ?? keyId });
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name)
     VALUES ($1,'o1',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [modelId, keyId, opts.provider ?? keyId, opts.model ?? modelId, opts.displayName ?? modelId]
  );
}

export async function usage(
  opts: {
    userId: string;
    modelId: string;
    tokens: number;
    ts: string;
    missing?: boolean;
  }
): Promise<void> {
  await testPool.query(
    `INSERT INTO token_usage(org_id, user_id, model_id, provider, token_in, token_out,
                             total_tokens, result_code, quota_window_date, usage_missing, ts)
     VALUES ('o1',$1,$2,'p',$3,0,$3,200,'2026-04-15',$4,$5)`,
    [opts.userId, opts.modelId, opts.tokens, opts.missing ?? false, opts.ts]
  );
}

export async function audit(
  action: string,
  opts: {
    targetType?: string | null;
    targetId?: string | null;
    payload?: unknown;
    userId?: string | null;
    ts?: string;
  } = {}
): Promise<void> {
  await testPool.query(
    `INSERT INTO audit_events(org_id, user_id, action, target_type, target_id, payload, ts)
     VALUES ('o1',$1,$2,$3,$4,$5,$6)`,
    [
      opts.userId ?? null,
      action,
      opts.targetType ?? null,
      opts.targetId ?? null,
      JSON.stringify(opts.payload ?? {}),
      opts.ts ?? '2026-04-15T09:00:00Z',
    ]
  );
}