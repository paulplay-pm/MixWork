// enterprise_server/tests/sso/migration045.test.ts
import '../helpers/setupEnv';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, test } from 'vitest';

import { splitStatements } from '../../src/db/migrate';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

// Re-applies migration 045 against the test DB. `testPool.query()` only
// accepts one prepared statement per call (pg-protocol refuses multi-
// statement bodies), so we split the file the same way `runMigrations()`
// does and exec each chunk individually.
const here = fileURLToPath(new URL('.', import.meta.url));
const MIGRATION_045 = readFileSync(
  join(here, '..', '..', 'src', 'db', 'migrations', '045_normalize_named_sso_urls.sql'),
  'utf8',
);
async function reApplyMigration045(): Promise<void> {
  for (const stmt of splitStatements(MIGRATION_045)) {
    await testPool.query(stmt);
  }
}

describe('migration 045 — normalize named SSO connection URLs', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
  });

  // Canonical URLs mirror `providerPresets.ts`; these constants double as
  // a guard — if `providerPresets.ts` ever changes the Feishu/DingTalk/
  // WeCom URLs, the corresponding constant and SQL need to move together.
  const FEISHU = {
    authorize: 'https://open.feishu.cn/open-apis/authen/v1/index',
    token:     'https://open.feishu.cn/open-apis/authen/v1/access_token',
    userinfo:  'https://open.feishu.cn/open-apis/authen/v1/user_info',
  } as const;
  const DINGTALK = {
    authorize: 'https://oapi.dingtalk.com/connect/oauth2/sns_authorize',
    token:     'https://oapi.dingtalk.com/sns/getuserinfo_bycode',
    userinfo:  'https://oapi.dingtalk.com/sns/getuserinfo_bycode',
  } as const;
  const WECOM = {
    authorize: 'https://open.weixin.qq.com/connect/oauth2/authorize',
    token:     'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
    userinfo:  'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo',
  } as const;

  type UrlRow = {
    authorize_url: string | null;
    token_url: string | null;
    userinfo_url: string | null;
  };
  async function getUrls(id: string): Promise<UrlRow> {
    const r = await testPool.query<UrlRow>(
      `SELECT authorize_url, token_url, userinfo_url FROM sso_connections WHERE id = $1`,
      [id]
    );
    return r.rows[0]!;
  }

  test('Feishu row with wrong URLs gets normalized to preset values', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   authorize_url, token_url, userinfo_url)
       VALUES ('c-wrong','o1','Feishu Wrong','feishu','oidc',
               'https://wrong.example/a','https://wrong.example/t','https://wrong.example/u')`
    );
    await reApplyMigration045();
    const row = await getUrls('c-wrong');
    expect(row.authorize_url).toBe(FEISHU.authorize);
    expect(row.token_url).toBe(FEISHU.token);
    expect(row.userinfo_url).toBe(FEISHU.userinfo);
  });

  test('Feishu: empty URLs get filled in (root cause of the user-reported bug)', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol)
       VALUES ('c-empty','o1','Feishu Empty','feishu','oidc')`
    );
    await reApplyMigration045();
    const row = await getUrls('c-empty');
    expect(row.authorize_url).toBe(FEISHU.authorize);
    expect(row.token_url).toBe(FEISHU.token);
    expect(row.userinfo_url).toBe(FEISHU.userinfo);
  });

  test('Idempotency: re-running on an already-normalized row is a no-op', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   authorize_url, token_url, userinfo_url)
       VALUES ('c-good','o1','Feishu Good','feishu','oidc',
               $1, $2, $3)`,
      [FEISHU.authorize, FEISHU.token, FEISHU.userinfo]
    );
    await reApplyMigration045();
    // Run the SQL a second time to assert idempotency.
    await reApplyMigration045();
    const row = await getUrls('c-good');
    expect(row.authorize_url).toBe(FEISHU.authorize);
    expect(row.token_url).toBe(FEISHU.token);
    expect(row.userinfo_url).toBe(FEISHU.userinfo);
  });

  test('Generic OIDC connection with custom URLs is left alone (provider-type gating)', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   authorize_url, token_url, userinfo_url)
       VALUES ('c-generic','o1','Custom Okta','generic-oidc','oidc',
               'https://corp.example/okta/a','https://corp.example/okta/t','https://corp.example/okta/u')`
    );
    await reApplyMigration045();
    const row = await getUrls('c-generic');
    expect(row.authorize_url).toBe('https://corp.example/okta/a');
    expect(row.token_url).toBe('https://corp.example/okta/t');
    expect(row.userinfo_url).toBe('https://corp.example/okta/u');
  });

  test('Dingtalk row with wrong URLs gets normalized', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   authorize_url, token_url, userinfo_url)
       VALUES ('c-dt','o1','Dingtalk Wrong','dingtalk','oauth2',
               'https://wrong/a','https://wrong/t','https://wrong/u')`
    );
    await reApplyMigration045();
    const row = await getUrls('c-dt');
    expect(row.authorize_url).toBe(DINGTALK.authorize);
    expect(row.token_url).toBe(DINGTALK.token);
    expect(row.userinfo_url).toBe(DINGTALK.userinfo);
  });

  test('WeCom row with wrong URLs gets normalized', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   authorize_url, token_url, userinfo_url)
       VALUES ('c-wc','o1','WeCom Wrong','wecom','oauth2',
               'https://wrong/a','https://wrong/t','https://wrong/u')`
    );
    await reApplyMigration045();
    const row = await getUrls('c-wc');
    expect(row.authorize_url).toBe(WECOM.authorize);
    expect(row.token_url).toBe(WECOM.token);
    expect(row.userinfo_url).toBe(WECOM.userinfo);
  });
});
