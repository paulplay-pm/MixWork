// enterprise_server/tests/sso/migration046.test.ts
import '../helpers/setupEnv';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, test } from 'vitest';

import { splitStatements } from '../../src/db/migrate';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const here = fileURLToPath(new URL('.', import.meta.url));
const MIGRATION_046 = readFileSync(
  join(here, '..', '..', 'src', 'db', 'migrations', '046_migrate_dingtalk_to_new_oauth2.sql'),
  'utf8',
);
async function reApplyMigration046(): Promise<void> {
  for (const stmt of splitStatements(MIGRATION_046)) {
    await testPool.query(stmt);
  }
}

describe('migration 046 — DingTalk → new OAuth2 flow', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
  });

  // The new endpoints + scope + identity field that 046 writes. Keep
  // these in sync with the comments in 046_migrate_dingtalk_to_new_oauth2.sql
  // — drift between this test and the SQL would silently let a stale
  // value escape to prod unnoticed.
  const DT = {
    authorize: 'https://login.dingtalk.com/oauth2/auth',
    token:     'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
    userinfo:  'https://api.dingtalk.com/v1.0/contact/users/me',
    // 046 first wrote `openid`; 047 patches it to include
    // `Contact.User.Read` so `/v1.0/contact/users/me` is callable.
    scope_v046: 'openid',
    field:      'unionId',  // camelCase — new API response shape
  } as const;

  type Row = {
    authorize_url: string | null;
    token_url: string | null;
    userinfo_url: string | null;
    scopes: string | null;
    identity_id_field: string;
  };
  async function getRow(id: string): Promise<Row> {
    const r = await testPool.query<Row>(
      `SELECT authorize_url, token_url, userinfo_url, scopes, identity_id_field
         FROM sso_connections WHERE id = $1`,
      [id]
    );
    return r.rows[0]!;
  }

  test('DingTalk row with legacy URLs gets rewritten to new OAuth2 endpoints', async () => {
    // Pre-migration row shape: the legacy `sns_authorize` + HMAC +
    // tmp_auth_code endpoints the v1 preset pinned before
    // migration 046. Admin overrides are preserved verbatim unless
    // they happen to already match the new values.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   authorize_url, token_url, userinfo_url,
                                   scopes, identity_id_field)
       VALUES ('c-dt','o1','钉钉 Legacy','dingtalk','oauth2',
               'https://oapi.dingtalk.com/connect/oauth2/sns_authorize',
               'https://oapi.dingtalk.com/sns/getuserinfo_bycode',
               'https://oapi.dingtalk.com/sns/getuserinfo_bycode',
               'snsapi_login', 'unionid')`
    );
    await reApplyMigration046();
    const row = await getRow('c-dt');
    expect(row.authorize_url).toBe(DT.authorize);
    expect(row.token_url).toBe(DT.token);
    expect(row.userinfo_url).toBe(DT.userinfo);
    expect(row.scopes).toBe(DT.scope_v046);
    expect(row.identity_id_field).toBe(DT.field);
  });

  test('Idempotency: re-running 046 on an already-migrated row is a no-op', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   authorize_url, token_url, userinfo_url,
                                   scopes, identity_id_field)
       VALUES ('c-good','o1','钉钉 New','dingtalk','oauth2',
               $1, $2, $3, $4, $5)`,
      [DT.authorize, DT.token, DT.userinfo, DT.scope_v046, DT.field]
    );
    await reApplyMigration046();
    await reApplyMigration046();
    const row = await getRow('c-good');
    expect(row.authorize_url).toBe(DT.authorize);
    expect(row.token_url).toBe(DT.token);
    expect(row.userinfo_url).toBe(DT.userinfo);
    expect(row.scopes).toBe(DT.scope_v046);
    expect(row.identity_id_field).toBe(DT.field);
  });

  test('Other provider types are NOT touched by 046', async () => {
    // A Feishu row should keep its migration-045 normalized URLs
    // (feishu.cn/oauth2/authen/v1/...) — the new DingTalk endpoints
    // must not leak into other providers.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   authorize_url, token_url, userinfo_url,
                                   scopes, identity_id_field)
       VALUES ('c-feishu','o1','飞书','feishu','oidc',
               'https://open.feishu.cn/open-apis/authen/v1/index',
               'https://open.feishu.cn/open-apis/authen/v1/access_token',
               'https://open.feishu.cn/open-apis/authen/v1/user_info',
               'contact:user.id:readonly', 'union_id')`
    );
    await reApplyMigration046();
    const row = await getRow('c-feishu');
    expect(row.authorize_url).toBe('https://open.feishu.cn/open-apis/authen/v1/index');
    expect(row.token_url).toBe('https://open.feishu.cn/open-apis/authen/v1/access_token');
    expect(row.identity_id_field).toBe('union_id');
    expect(row.scopes).toBe('contact:user.id:readonly');
  });
});
