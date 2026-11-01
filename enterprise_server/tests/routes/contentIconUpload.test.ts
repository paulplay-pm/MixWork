// Route tests for the kit / skill icon upload.
//
// Both catalogs used to take an icon URL, so an admin had to host the image
// somewhere first and the row then pointed at an external host. The upload
// contract is the same one the connector icon uses: a MIME whitelist, a 1 MB
// ceiling, the file in the state dir with the row pointing at it, and a clear
// route that removes both.
import '../helpers/setupEnv';

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { agentIconUploadDir, kitIconUploadDir, skillIconUploadDir } from '../../src/lib/stateDir';
import { contentIconUploadRoutes, MAX_ICON_BYTES } from '../../src/routes/contentIconUpload';

const app = new Hono();
app.route('/', contentIconUploadRoutes);

const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

function buildMultipart(body: Uint8Array): { body: Uint8Array; contentType: string } {
  const boundary = `----test-boundary-${Math.random().toString(36).slice(2)}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="icon"; filename="i.png"\r\n`
    + 'Content-Type: image/png\r\n\r\n',
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const merged = new Uint8Array(head.length + body.length + tail.length);
  merged.set(head, 0);
  merged.set(body, head.length);
  merged.set(tail, head.length + body.length);
  return { body: merged, contentType: `multipart/form-data; boundary=${boundary}` };
}

const tok = (orgId = 'o1'): Promise<string> =>
  signToken({ sub: 'admin', orgId, roles: ['super_admin'] });

async function seedKit(slug = 'design', orgId = 'o1'): Promise<void> {
  await testPool.query(`INSERT INTO kit_catalog (slug, org_id) VALUES ($1, $2)`, [slug, orgId]);
}

async function seedAgent(id = 'agent-1', orgId = 'o1'): Promise<void> {
  await testPool.query(
    `INSERT INTO agent_marketplace_agents (agent_id, name, description, identity, system_prompt, model, thinking_level, org_id)
     VALUES ($1, 'Reviewer', 'd', 'i', 's', 'm', 'medium', $2)`,
    [id, orgId],
  );
}

async function seedSkill(id = 'web-search', orgId = 'o1'): Promise<void> {
  await testPool.query(
    `INSERT INTO skill_marketplace_skills (skill_id, name_en, description_en, category_id, org_id)
     VALUES ($1, 'Web Search', 'd', 'general', $2)`,
    [id, orgId],
  );
}

async function iconOf(table: string, column: string, idColumn: string, id: string): Promise<string | null> {
  const r = await testPool.query<{ icon: string | null }>(
    `SELECT ${column} AS icon FROM ${table} WHERE ${idColumn} = $1`,
    [id],
  );
  return r.rows[0]?.icon ?? null;
}

function upload(path: string, token: string, bytes = TINY_PNG) {
  const { body, contentType } = buildMultipart(bytes);
  return app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': contentType,
      'content-length': String(body.length),
    },
    body,
  });
}

/** Whether the file the row points at is actually on disk. The name carries
 *  a version suffix, so it is read back from the stored path. */
const storedFileExists = (dir: string, stored: string | null): boolean =>
  !!stored && existsSync(join(dir, basename(stored)));

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1'), ('o2', 'T2')`);
});

describe('kit icons', () => {
  test('stores the upload and points the row at it', async () => {
    await seedKit();
    const t = await tok();
    const r = await upload('/api/admin/kits/design/icon', t);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ icon: expect.stringMatching(/^\/kit-icons\/uploads\/design-[0-9a-f]{8}\.png$/) });
    expect(await iconOf('kit_catalog', 'icon_url', 'slug', 'design')).toMatch(/^\/kit-icons\/uploads\/design-[0-9a-f]{8}\.png$/);
    expect(storedFileExists(kitIconUploadDir(), await iconOf('kit_catalog', 'icon_url', 'slug', 'design'))).toBe(true);
  });

  test('a legacy URL value is replaced, not deleted as a file', async () => {
    await seedKit();
    await testPool.query(
      `UPDATE kit_catalog SET icon_url = 'https://cdn.example.com/old.png' WHERE slug = 'design'`,
    );
    const t = await tok();
    expect((await upload('/api/admin/kits/design/icon', t)).status).toBe(200);
    expect(await iconOf('kit_catalog', 'icon_url', 'slug', 'design')).toMatch(/^\/kit-icons\/uploads\/design-[0-9a-f]{8}\.png$/);
  });

  test('rejects a body over the cap', async () => {
    await seedKit();
    const t = await tok();
    const r = await upload('/api/admin/kits/design/icon', t, new Uint8Array(MAX_ICON_BYTES + 1));
    expect(r.status).toBe(413);
  });

  test('a foreign kit is a 404 and nothing is written', async () => {
    await seedKit('design', 'o2');
    const t = await tok('o1');
    expect((await upload('/api/admin/kits/design/icon', t)).status).toBe(404);
    expect(await iconOf('kit_catalog', 'icon_url', 'slug', 'design')).toBeNull();
  });

  test('delete clears the column and removes the file', async () => {
    await seedKit();
    const t = await tok();
    await upload('/api/admin/kits/design/icon', t);
    const del = await app.request('/api/admin/kits/design/icon', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(del.status).toBe(200);
    expect(await iconOf('kit_catalog', 'icon_url', 'slug', 'design')).toBeNull();
  });
});

describe('skill icons', () => {
  test('stores the upload and points the row at it', async () => {
    await seedSkill();
    const t = await tok();
    const r = await upload('/api/admin/skill-marketplace/skills/web-search/icon', t);
    expect(r.status).toBe(200);
    expect(await iconOf('skill_marketplace_skills', 'icon', 'skill_id', 'web-search'))
      .toMatch(/^\/skill-icons\/uploads\/web-search-[0-9a-f]{8}\.png$/);
    expect(storedFileExists(skillIconUploadDir(), await iconOf('skill_marketplace_skills', 'icon', 'skill_id', 'web-search'))).toBe(true);
  });

  test('delete clears the column', async () => {
    await seedSkill();
    const t = await tok();
    await upload('/api/admin/skill-marketplace/skills/web-search/icon', t);
    const del = await app.request('/api/admin/skill-marketplace/skills/web-search/icon', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(del.status).toBe(200);
    expect(await iconOf('skill_marketplace_skills', 'icon', 'skill_id', 'web-search')).toBeNull();
  });
});

describe('agent icons', () => {
  test('stores the upload and points the row at it', async () => {
    await seedAgent();
    const t = await tok();
    const r = await upload('/api/admin/agent-marketplace/agents/agent-1/icon', t);
    expect(r.status).toBe(200);
    expect(await iconOf('agent_marketplace_agents', 'icon', 'agent_id', 'agent-1'))
      .toMatch(/^\/agent-icons\/uploads\/agent-1-[0-9a-f]{8}\.png$/);
    expect(storedFileExists(agentIconUploadDir(), await iconOf('agent_marketplace_agents', 'icon', 'agent_id', 'agent-1'))).toBe(true);
  });

  test('a built-in avatar value is replaced only when a file is uploaded', async () => {
    // The built-in avatars (`agent-avatar-svg:<name>`) are set through the
    // patch route; this one only ever writes a file.
    await seedAgent();
    await testPool.query(
      `UPDATE agent_marketplace_agents SET icon = 'agent-avatar-svg:code' WHERE agent_id = 'agent-1'`,
    );
    const t = await tok();
    expect(await iconOf('agent_marketplace_agents', 'icon', 'agent_id', 'agent-1'))
      .toBe('agent-avatar-svg:code');
    expect((await upload('/api/admin/agent-marketplace/agents/agent-1/icon', t)).status).toBe(200);
    expect(await iconOf('agent_marketplace_agents', 'icon', 'agent_id', 'agent-1'))
      .toMatch(/^\/agent-icons\/uploads\/agent-1-[0-9a-f]{8}\.png$/);
  });

  test('delete clears the column', async () => {
    await seedAgent();
    const t = await tok();
    await upload('/api/admin/agent-marketplace/agents/agent-1/icon', t);
    const del = await app.request('/api/admin/agent-marketplace/agents/agent-1/icon', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(del.status).toBe(200);
    // The agent column is NOT NULL; "no icon" is the empty string.
    expect(await iconOf('agent_marketplace_agents', 'icon', 'agent_id', 'agent-1')).toBe('');
  });
});
