// The gateway is registered on a path the SPA fallback also matches
// (`app.get('*')`). Hono answers in registration order, so mounting the
// gateway after the fallback still looks healthy for POST/DELETE and only
// breaks GET — which is exactly how an MCP SSE stream starts. This test is
// the only thing that pins the ordering.
import '../helpers/setupEnv';

import { describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { buildApp } from '../../src/server';

describe('the gateway is mounted inside the API, before the SPA fallback', () => {
  test('an unauthenticated gateway GET answers JSON, not the console html', async () => {
    const res = await buildApp().request('/mcp/gateway/sk-1');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('the token route is reachable', async () => {
    const res = await buildApp().request('/mcp/gateway/sk-1/token', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
