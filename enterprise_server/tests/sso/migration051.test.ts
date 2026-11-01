// enterprise_server/tests/sso/migration051.test.ts
import '../helpers/setupEnv';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, test } from 'vitest';

import { splitStatements } from '../../src/db/migrate';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const here = fileURLToPath(new URL('.', import.meta.url));
const MIGRATION_051 = readFileSync(
  join(here, '..', '..', 'src', 'db', 'migrations', '051_wecom_qrconnect_authorize_url.sql'),
  'utf8',
);
async function reApplyMigration051(): Promise<void> {
  for (const stmt of splitStatements(MIGRATION_051)) await testPool.query(stmt);
}

const QR_CONNECT = 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect';
const IN_APP = 'https://open.weixin.qq.com/connect/oauth2/authorize';

describe('migration 051 — WeCom authorize → PC scan-code endpoint', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
  });

  test('WeCom row on the in-app endpoint is repointed at qrConnect', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, email_domain_whitelist)
       VALUES ('c-wecom','o1','企业微信','wecom','oidc',$1,'[]'::jsonb)`,
      [IN_APP],
    );
    await reApplyMigration051();
    const r = await testPool.query<{ authorize_url: string }>(
      `SELECT authorize_url FROM sso_connections WHERE id = 'c-wecom'`,
    );
    expect(r.rows[0]?.authorize_url).toBe(QR_CONNECT);
  });

  test('Idempotent: re-running on an already-migrated row is a no-op', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, email_domain_whitelist)
       VALUES ('c-ok','o1','企业微信 OK','wecom','oidc',$1,'[]'::jsonb)`,
      [QR_CONNECT],
    );
    await reApplyMigration051();
    await reApplyMigration051();
    const r = await testPool.query<{ authorize_url: string }>(
      `SELECT authorize_url FROM sso_connections WHERE id = 'c-ok'`,
    );
    expect(r.rows[0]?.authorize_url).toBe(QR_CONNECT);
  });

  test('Other providers keep their authorize_url', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   authorize_url, email_domain_whitelist)
       VALUES ('c-feishu','o1','飞书','feishu','oidc',
               'https://open.feishu.cn/open-apis/authen/v1/index','[]'::jsonb)`,
    );
    await reApplyMigration051();
    const r = await testPool.query<{ authorize_url: string }>(
      `SELECT authorize_url FROM sso_connections WHERE id = 'c-feishu'`,
    );
    expect(r.rows[0]?.authorize_url).toBe('https://open.feishu.cn/open-apis/authen/v1/index');
  });
});
