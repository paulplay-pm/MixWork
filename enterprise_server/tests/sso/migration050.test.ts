// enterprise_server/tests/sso/migration050.test.ts
import '../helpers/setupEnv';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, test } from 'vitest';

import { splitStatements } from '../../src/db/migrate';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const here = fileURLToPath(new URL('.', import.meta.url));
const MIGRATION_050 = readFileSync(
  join(here, '..', '..', 'src', 'db', 'migrations', '050_sso_wecom_agentid.sql'),
  'utf8',
);
async function reApplyMigration050(): Promise<void> {
  for (const stmt of splitStatements(MIGRATION_050)) await testPool.query(stmt);
}

describe('migration 050 — WeCom agentid column + field corrections', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
  });

  test('agentid column exists and defaults to NULL', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, email_domain_whitelist)
       VALUES ('c-new','o1','WeCom New','wecom','oidc','[]'::jsonb)`,
    );
    const r = await testPool.query<{ agentid: string | null }>(
      `SELECT agentid FROM sso_connections WHERE id = 'c-new'`,
    );
    expect(r.rows[0]?.agentid).toBeNull();
  });

  test('stale WeCom row gets scope / identity-field / login-name corrected', async () => {
    // Reproduce the pre-050 row shape: the manual `snsapi_private_info`
    // scope (with a spurious underscore and manual-consent semantics),
    // lowercase `userid`, and a stale login_name_field.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   authorize_url, token_url, userinfo_url,
                                   scopes, identity_id_field, login_name_field, email_domain_whitelist)
       VALUES ('c-wecom','o1','企业微信','wecom','oidc',
               'https://open.weixin.qq.com/connect/oauth2/authorize',
               'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
               'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo',
               'snsapi_private_info', 'userid', 'name', '[]'::jsonb)`,
    );
    await reApplyMigration050();
    const r = await testPool.query<{ scopes: string; identity_id_field: string; login_name_field: string | null }>(
      `SELECT scopes, identity_id_field, login_name_field FROM sso_connections WHERE id = 'c-wecom'`,
    );
    expect(r.rows[0]?.scopes).toBe('snsapi_base');
    expect(r.rows[0]?.identity_id_field).toBe('UserId');
    expect(r.rows[0]?.login_name_field).toBeNull();
  });

  test('WeCom row already using snsapi_base is left alone (idempotent)', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   scopes, identity_id_field, login_name_field, email_domain_whitelist)
       VALUES ('c-ok','o1','企业微信 OK','wecom','oidc','snsapi_base','UserId',NULL,'[]'::jsonb)`,
    );
    await reApplyMigration050();
    await reApplyMigration050();  // idempotent
    const r = await testPool.query<{ scopes: string; identity_id_field: string; login_name_field: string | null }>(
      `SELECT scopes, identity_id_field, login_name_field FROM sso_connections WHERE id = 'c-ok'`,
    );
    expect(r.rows[0]?.scopes).toBe('snsapi_base');
    expect(r.rows[0]?.identity_id_field).toBe('UserId');
    expect(r.rows[0]?.login_name_field).toBeNull();
  });

  test('Non-WeCom providers are NOT touched by 050', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
                                   scopes, identity_id_field, email_domain_whitelist)
       VALUES ('c-feishu','o1','飞书','feishu','oidc','contact:user.id:readonly','union_id','[]'::jsonb)`,
    );
    await reApplyMigration050();
    const r = await testPool.query<{ scopes: string; identity_id_field: string }>(
      `SELECT scopes, identity_id_field FROM sso_connections WHERE id = 'c-feishu'`,
    );
    expect(r.rows[0]?.scopes).toBe('contact:user.id:readonly');
    expect(r.rows[0]?.identity_id_field).toBe('union_id');
  });
});
