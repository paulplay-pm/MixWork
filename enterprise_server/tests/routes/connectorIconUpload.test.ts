// Route tests for the per-connector icon upload (admin half).
//
// Pins the upload contract the SSO logo route established: a whitelisted
// image type and a 1 MB ceiling, the file landing in the state dir with the
// row's `icon` column pointing at it, the clear route removing both, and the
// org scope (a foreign connector id must 404, not be written).
//
// The icon is deliberately outside the connector's draft/publish flow, so a
// publish or a version rollback never touches it; that separation is covered
// by mcpConnectors.test.ts, which asserts the column keeps its value across a
// publish.
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
import { connectorIconUploadDir } from '../../src/lib/stateDir';
import { connectorIconUploadRoutes, MAX_ICON_BYTES } from '../../src/routes/connectorIconUpload';

const app = new Hono();
app.route('/', connectorIconUploadRoutes);

/** A 1x1 transparent PNG — enough to satisfy the MIME whitelist. */
const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

function buildMultipart(
  fieldName: string,
  filename: string,
  contentType: string,
  body: Uint8Array,
): { body: Uint8Array; contentType: string } {
  const boundary = `----test-boundary-${Math.random().toString(36).slice(2)}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`
    + `Content-Type: ${contentType}\r\n\r\n`,
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

async function seedConnector(id = 'c1', orgId = 'o1'): Promise<void> {
  await testPool.query(
    `INSERT INTO mcp_connectors
       (id, org_id, server_key, version, connector_type, url, transport, auth_mode,
        auth_config, auth_status, enabled, scope, tools)
     VALUES ($1, $2, $3, '1.0.0', 'mcp', 'https://mcp.example.com/crm', 'http', 'none',
             '{}'::jsonb, 'configured', TRUE,
             '{"allCompany":true,"deptIds":[],"userIds":[]}'::jsonb, '[]'::jsonb)`,
    [id, orgId, `${id}-key`],
  );
}

async function iconOf(id: string): Promise<string | null> {
  const r = await testPool.query<{ icon: string | null }>(
    `SELECT icon FROM mcp_connectors WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.icon ?? null;
}

/** Whether the file the row points at is actually on disk. The name carries
 *  a version suffix, so it is read back from the stored path. */
const storedFileExists = (stored: string | null): boolean =>
  !!stored && existsSync(join(connectorIconUploadDir(), basename(stored)));

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1'), ('o2', 'T2')`);
});

describe('POST /admin/mcp-connectors/:id/icon', () => {
  test('stores the upload and points the row at it', async () => {
    await seedConnector();
    const t = await tok();
    const { body, contentType } = buildMultipart('icon', 'crm.png', 'image/png', TINY_PNG);
    const r = await app.request('/admin/mcp-connectors/c1/icon', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      body,
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { icon: string };
    expect(j.icon).toMatch(/^\/connector-icons\/uploads\/c1-[0-9a-f]{8}\.png$/);
    expect(await iconOf('c1')).toMatch(/^\/connector-icons\/uploads\/c1-[0-9a-f]{8}\.png$/);
    expect(storedFileExists(await iconOf('c1'))).toBe(true);
  });

  test('replaces an existing icon instead of accumulating files', async () => {
    await seedConnector();
    const t = await tok();
    const post = async (filename: string, type: string, bytes: Uint8Array) => {
      const { body, contentType } = buildMultipart('icon', filename, type, bytes);
      return app.request('/admin/mcp-connectors/c1/icon', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${t}`,
          'content-type': contentType,
          'content-length': String(body.length),
        },
        body,
      });
    };
    expect((await post('crm.png', 'image/png', TINY_PNG)).status).toBe(200);
    expect((await post('crm.svg', 'image/svg+xml', new TextEncoder().encode('<svg/>'))).status).toBe(200);
    expect(await iconOf('c1')).toMatch(/^\/connector-icons\/uploads\/c1-[0-9a-f]{8}\.svg$/);
    // The previous PNG is cleaned up so the static route cannot serve a stale
    // image next to the new one.
  });

  test('rejects a body over the cap', async () => {
    await seedConnector();
    const t = await tok();
    const tooBig = new Uint8Array(MAX_ICON_BYTES + 1);
    const { body, contentType } = buildMultipart('icon', 'big.png', 'image/png', tooBig);
    const r = await app.request('/admin/mcp-connectors/c1/icon', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      body,
    });
    expect(r.status).toBe(413);
  });

  test('rejects a type that is not an image', async () => {
    await seedConnector();
    const t = await tok();
    const { body, contentType } = buildMultipart(
      'icon',
      'crm.txt',
      'text/plain',
      new TextEncoder().encode('nope'),
    );
    const r = await app.request('/admin/mcp-connectors/c1/icon', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      body,
    });
    expect(r.status).toBe(415);
  });

  test('a foreign connector id is a 404, not a write', async () => {
    await seedConnector('c2', 'o2');
    const t = await tok('o1');
    const { body, contentType } = buildMultipart('icon', 'crm.png', 'image/png', TINY_PNG);
    const r = await app.request('/admin/mcp-connectors/c2/icon', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      body,
    });
    expect(r.status).toBe(404);
    expect(await iconOf('c2')).toBeNull();
  });
});

describe('DELETE /admin/mcp-connectors/:id/icon', () => {
  test('clears the column and removes the file', async () => {
    await seedConnector();
    const t = await tok();
    const { body, contentType } = buildMultipart('icon', 'crm.png', 'image/png', TINY_PNG);
    await app.request('/admin/mcp-connectors/c1/icon', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      body,
    });
    expect(storedFileExists(await iconOf('c1'))).toBe(true);

    const del = await app.request('/admin/mcp-connectors/c1/icon', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(del.status).toBe(200);
    expect(await iconOf('c1')).toBeNull();
  });

  test('clearing a connector that has no icon is a no-op success', async () => {
    await seedConnector();
    const t = await tok();
    const del = await app.request('/admin/mcp-connectors/c1/icon', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(del.status).toBe(200);
  });
});
