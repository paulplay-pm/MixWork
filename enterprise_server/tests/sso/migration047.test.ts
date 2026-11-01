// enterprise_server/tests/sso/migration047.test.ts
import '../helpers/setupEnv';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, test } from 'vitest';

import { splitStatements } from '../../src/db/migrate';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const here = fileURLToPath(new URL('.', import.meta.url));
const MIGRATION_047 = readFileSync(
  join(here, '..', '..', 'src', 'db', 'migrations', '047_dingtalk_scope_contact_user_read.sql'),
  'utf8',
);
async function reApplyMigration047(): Promise<void> {
  for (const stmt of splitStatements(MIGRATION_047)) {
    await testPool.query(stmt);
  }
}

describe('migration 047 — DingTalk scope → Contact.User.Read', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
  });

  test('DingTalk row with bare `openid` scope gets `Contact.User.Read` appended', async () => {
    // Pre-migration row matches what migration 046 left behind: the
    // new OAuth2 endpoints with `openid` only. 047 ups the scope to
    // include `Contact.User.Read` so `/v1.0/contact/users/me` stops
    // 403ing. The exact production sequence was 046 first (writes
    // `openid`), then a token exchange + userinfo failure surfaces
    // the missing scope.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, scopes)
       VALUES ('c-v046','o1','钉钉 v046','dingtalk','oauth2','openid')`
    );
    await reApplyMigration047();
    const r = await testPool.query<{ scopes: string }>(
      `SELECT scopes FROM sso_connections WHERE id = $1`, ['c-v046']
    );
    expect(r.rows[0]!.scopes).toBe('openid Contact.User.Read');
  });

  test('Idempotency: re-running 047 on an already-updated row is a no-op', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, scopes)
       VALUES ('c-good','o1','钉钉 Full','dingtalk','oauth2','openid Contact.User.Read')`
    );
    await reApplyMigration047();
    await reApplyMigration047();
    const r = await testPool.query<{ scopes: string }>(
      `SELECT scopes FROM sso_connections WHERE id = $1`, ['c-good']
    );
    expect(r.rows[0]!.scopes).toBe('openid Contact.User.Read');
  });

  test('Admin-customised scopes (e.g. `openid profile email`) are preserved verbatim', async () => {
    // `IS DISTINCT FROM` only catches rows that match the exact `openid`
    // string — anything more elaborate (e.g. an admin added extra OAuth2
    // scopes via the form before 047 ran) is intentionally preserved
    // untouched. 047 is a one-shot corrective migration, not a
    // scope-format normaliser.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, scopes)
       VALUES ('c-custom','o1','钉钉 Custom','dingtalk','oauth2','openid profile email')`
    );
    await reApplyMigration047();
    const r = await testPool.query<{ scopes: string }>(
      `SELECT scopes FROM sso_connections WHERE id = $1`, ['c-custom']
    );
    expect(r.rows[0]!.scopes).toBe('openid profile email');
  });

  test('Other provider types are NOT touched by 047', async () => {
    // Feishu's `contact:user.id:readonly` scope is unrelated to DingTalk's
    // userinfo permission — the WHERE clause must gate on provider_type
    // so a future DingTalk-scope rewrite doesn't leak into Feishu.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, scopes)
       VALUES ('c-feishu','o1','飞书','feishu','oidc','contact:user.id:readonly')`
    );
    await reApplyMigration047();
    const r = await testPool.query<{ scopes: string }>(
      `SELECT scopes FROM sso_connections WHERE id = $1`, ['c-feishu']
    );
    expect(r.rows[0]!.scopes).toBe('contact:user.id:readonly');
  });
});
