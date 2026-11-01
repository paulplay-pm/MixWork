import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { authService } from '../../src/auth/authService';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { modelCatalog } from '../../src/models/modelCatalog';
import { idempotency } from '../../src/proxy/idempotency';
import { providerProxy } from '../../src/proxy/providerProxy';
import { callOpenAI } from '../../src/proxy/upstream';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

/** An SSE response delivered in the exact chunk boundaries given. */
function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

/**
 * Accounting for a streamed call necessarily happens after the response
 * promise has resolved — the usage does not exist until the client has
 * drained the body — so the row lands a few microtasks later. Poll rather
 * than assert immediately, so the test measures the settled state and not the
 * scheduling of the write.
 */
async function waitFor<T>(read: () => Promise<T | null>, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface UsageRow {
  token_in: number;
  token_out: number;
  total_tokens: number;
  usage_missing: boolean;
  result_code: number;
}

describe('proxy/proxyAccounting', () => {
  let userId: string;

  beforeEach(async () => {
    fetchMock.mockReset();
    idempotency.clear();
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1', 'T', 'UTC')`);
    // provider_keys.created_by is an FK to users(id); authService hands back
    // the generated UUID the claim's `sub` then has to match.
    const u = await authService.createUser({ orgId: 'o1', username: 'alice', password: 'pw' });
    userId = u.id;
  });

  // token_usage.model_id is NOT NULL REFERENCES model_catalog(id) with no
  // ON DELETE, so orgs -> provider_keys -> model_catalog must all exist
  // before any usage insert.
  async function seedModel(opts: { quotaPerDay?: number } = {}) {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-test',
      label: 'p',
      createdBy: userId,
      endpoint: 'https://api.example.com/v1',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
      quotaPerDay: opts.quotaPerDay,
    });
    return { keyId: k.id, modelId: m.id };
  }

  function handleStreaming(modelId: string) {
    return providerProxy.handle(
      'openai',
      { model_id: modelId, body: { model: 'gpt-4o', messages: [], stream: true } },
      { sub: userId, orgId: 'o1', roles: [] }
    );
  }

  function sentBody(call: number): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[call] as unknown as [string, RequestInit];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  async function readUsageRow(modelId: string): Promise<UsageRow | null> {
    const r = await testPool.query<UsageRow>(
      `SELECT token_in, token_out, total_tokens, usage_missing, result_code
         FROM token_usage WHERE user_id=$1 AND model_id=$2`,
      [userId, modelId]
    );
    return r.rows[0] ?? null;
  }

  async function readFlag(keyId: string): Promise<boolean | null> {
    const r = await testPool.query<{ stream_usage_supported: boolean | null }>(
      `SELECT stream_usage_supported FROM provider_keys WHERE id=$1`,
      [keyId]
    );
    return r.rows[0]?.stream_usage_supported ?? null;
  }

  async function readAuditRow(modelId: string): Promise<{ action: string; payload: Record<string, unknown> } | null> {
    const r = await testPool.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM audit_events WHERE action='provider_call' AND target_id=$1`,
      [modelId]
    );
    return r.rows[0] ?? null;
  }

  /** Drain the whole accounting chain for a streaming call. The row lands off
   *  the response path, so a test that returns while it is still writing would
   *  race the next `resetSchema()`; waiting for the audit event (written after
   *  the row) guarantees nothing is still in flight. */
  async function awaitAccounting(modelId: string): Promise<void> {
    await waitFor(() => readUsageRow(modelId), 'the token_usage row');
    await waitFor(() => readAuditRow(modelId), 'the provider_call audit event');
  }

  test('a stream that never carries usage still records the call, flagged missing', async () => {
    const { modelId } = await seedModel();
    fetchMock.mockResolvedValueOnce(
      new Response(sseStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'), {
        status: 200,
      })
    );

    const res = await handleStreaming(modelId);
    expect(res.status).toBe(200);
    // The client still receives the real events, framing intact.
    expect(await res.text()).toBe('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');

    const row = await waitFor(() => readUsageRow(modelId), 'the token_usage row');
    expect(row.token_in).toBe(0);
    expect(row.token_out).toBe(0);
    expect(row.total_tokens).toBe(0);
    expect(row.usage_missing).toBe(true);
    expect(row.result_code).toBe(200);

    await awaitAccounting(modelId);
    const audit = await readAuditRow(modelId);
    expect(audit?.payload.usage_missing).toBe(true);
  });

  test('a stream carrying usage records the real token counts', async () => {
    const { modelId } = await seedModel();
    fetchMock.mockResolvedValueOnce(
      new Response(
        sseStream(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":34}}\n\n',
          'data: [DONE]\n\n'
        ),
        { status: 200 }
      )
    );

    const res = await handleStreaming(modelId);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data: [DONE]');

    const row = await waitFor(() => readUsageRow(modelId), 'the token_usage row');
    expect(row.token_in).toBe(120);
    expect(row.token_out).toBe(34);
    expect(row.total_tokens).toBe(154);
    expect(row.usage_missing).toBe(false);

    await awaitAccounting(modelId);
    const audit = await readAuditRow(modelId);
    expect(audit?.payload.token_in).toBe(120);
    expect(audit?.payload.usage_missing).toBeUndefined();
  });

  test('the quota reservation path is unchanged', async () => {
    const { modelId } = await seedModel({ quotaPerDay: 100 });
    const today = new Date().toISOString().slice(0, 10);
    await testPool.query(
      `INSERT INTO token_usage(org_id, user_id, model_id, provider, token_in, token_out, total_tokens, result_code, quota_window_date)
       VALUES ('o1', $1, $2, 'openai', 60, 40, 100, 200, $3)`,
      [userId, modelId, today]
    );

    const res = await handleStreaming(modelId);
    expect(res.status).toBe(429);
    // Still blocked before any upstream round-trip.
    expect(fetchMock).not.toHaveBeenCalled();

    const r = await testPool.query<UsageRow>(
      `SELECT token_in, token_out, total_tokens, usage_missing, result_code
         FROM token_usage WHERE user_id=$1 AND model_id=$2 AND result_code=429`,
      [userId, modelId]
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].total_tokens).toBe(0);
    // We know the call was never forwarded, so its zero is definitive, not missing.
    expect(r.rows[0].usage_missing).toBe(false);
  });

  test('a streaming request asks upstream for stream_options.include_usage', async () => {
    const { modelId } = await seedModel();
    fetchMock.mockResolvedValueOnce(new Response(sseStream('data: [DONE]\n\n'), { status: 200 }));

    const res = await handleStreaming(modelId);
    expect(res.status).toBe(200);
    await res.text();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = sentBody(0);
    expect(body.stream_options).toEqual({ include_usage: true });
    // The client's own body is otherwise untouched.
    expect(body.stream).toBe(true);
    expect(body.model).toBe('gpt-4o');
    await awaitAccounting(modelId);
  });

  test('a 4xx on stream_options retries once without it and remembers the downgrade', async () => {
    const { keyId, modelId } = await seedModel();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'unknown field stream_options' } }), {
        status: 400,
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        sseStream('data: {"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n', 'data: [DONE]\n\n'),
        { status: 200 }
      )
    );

    const res = await handleStreaming(modelId);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data: [DONE]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0).stream_options).toEqual({ include_usage: true });
    expect(sentBody(1).stream_options).toBeUndefined();

    // The degraded capability is persisted, so a restart does not make every
    // deployment pay the failed round-trip forever.
    const k = await waitFor(async () => {
      const r = await testPool.query<{ stream_usage_supported: boolean | null }>(
        `SELECT stream_usage_supported FROM provider_keys WHERE id=$1`,
        [keyId]
      );
      return r.rows[0]?.stream_usage_supported === false ? r.rows[0] : null;
    }, 'the persisted capability downgrade');
    expect(k.stream_usage_supported).toBe(false);

    // The retry still yields a fully accounted call.
    const row = await waitFor(() => readUsageRow(modelId), 'the token_usage row');
    expect(row.token_in).toBe(8);
    expect(row.usage_missing).toBe(false);
  });

  test('a known-unsupported endpoint is not probed again', async () => {
    const { keyId, modelId } = await seedModel();
    await testPool.query(
      `UPDATE provider_keys SET stream_usage_supported=false WHERE id=$1`,
      [keyId]
    );
    fetchMock.mockResolvedValueOnce(new Response(sseStream('data: [DONE]\n\n'), { status: 200 }));

    const res = await handleStreaming(modelId);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data: [DONE]');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(0).stream_options).toBeUndefined();

    const row = await waitFor(() => readUsageRow(modelId), 'the token_usage row');
    expect(row.usage_missing).toBe(true);
    await awaitAccounting(modelId);
  });

  // ---- R28: the downgrade must be cause-based, not status-based.
  //
  // OpenAI answers with 400 for BOTH "Unrecognized request argument supplied:
  // stream_options" and `context_length_exceeded`, so keying the downgrade on
  // the status alone lets a single over-long prompt permanently blind usage
  // accounting for that key — and grep shows there is no admin route, UI
  // toggle, TTL or re-probe to undo it. Only a rejection that names the field
  // is evidence about this endpoint's capability.

  test('an OpenAI "unrecognized request argument" rejection persists the downgrade', async () => {
    const { keyId, modelId } = await seedModel();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: 'Unrecognized request argument supplied: stream_options',
            type: 'invalid_request_error',
            param: 'stream_options',
            code: 'unknown_parameter',
          },
        }),
        { status: 400 }
      )
    );
    fetchMock.mockResolvedValueOnce(new Response(sseStream('data: [DONE]\n\n'), { status: 200 }));

    const res = await handleStreaming(modelId);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('[DONE]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(1).stream_options).toBeUndefined();
    expect(await readFlag(keyId)).toBe(false);
    await awaitAccounting(modelId);
  });

  test('a rejection that names the field only in its message still persists', async () => {
    const { keyId, modelId } = await seedModel();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: 'stream_options is not supported by this endpoint' } }),
        { status: 400 }
      )
    );
    fetchMock.mockResolvedValueOnce(new Response(sseStream('data: [DONE]\n\n'), { status: 200 }));

    await handleStreaming(modelId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await readFlag(keyId)).toBe(false);
  });

  // The negative control that matters: a 400 that is about the request, not
  // about our field. `param` names `messages`, `code` is a length error and the
  // message never mentions the field — nothing here implicates stream_options.
  test('a context_length_exceeded 400 retries but does NOT persist a downgrade', async () => {
    const { keyId, modelId } = await seedModel();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message:
              "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.",
            type: 'invalid_request_error',
            param: 'messages',
            code: 'context_length_exceeded',
          },
        }),
        { status: 400 }
      )
    );
    fetchMock.mockResolvedValueOnce(new Response(sseStream('data: [DONE]\n\n'), { status: 200 }));

    const res = await handleStreaming(modelId);
    // The retry still keeps the call working.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('[DONE]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(1).stream_options).toBeUndefined();
    // But the capability memory stays NULL, so the next request re-probes.
    expect(await readFlag(keyId)).toBeNull();
    await awaitAccounting(modelId);
  });

  test('a 429 does not persist a downgrade', async () => {
    const { keyId, modelId } = await seedModel();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Rate limit reached for gpt-4o' } }), {
        status: 429,
      })
    );
    fetchMock.mockResolvedValueOnce(new Response(sseStream('data: [DONE]\n\n'), { status: 200 }));

    await handleStreaming(modelId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await readFlag(keyId)).toBeNull();
  });

  // Stronger still: the status gate must win even when the message DOES name
  // the field. A 401 is about the credential; nothing in its text can tell us
  // anything about whether this endpoint accepts stream_options.
  test('a 401 mentioning the field does not persist a downgrade', async () => {
    const { keyId, modelId } = await seedModel();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'Invalid api key. stream_options was not accepted.' },
        }),
        { status: 401 }
      )
    );
    fetchMock.mockResolvedValueOnce(new Response(sseStream('data: [DONE]\n\n'), { status: 200 }));

    await handleStreaming(modelId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await readFlag(keyId)).toBeNull();
  });

  // ---- R29: "we could not measure this" is not the same claim as "this
  // consumed nothing". An error envelope carries no usage, but its zero is
  // definitive — counting it as unmeasured inflates `unaccounted_calls`, which
  // exists precisely so an admin can trust the token totals.

  test('a streaming 4xx error envelope is not flagged as an unmeasured call', async () => {
    const { modelId } = await seedModel();
    const body = JSON.stringify({
      error: { message: 'bad request', type: 'invalid_request_error', code: 'invalid_request' },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 400 }));
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 400 }));

    const res = await handleStreaming(modelId);
    expect(res.status).toBe(400);
    await res.text();

    const row = await waitFor(() => readUsageRow(modelId), 'the token_usage row');
    expect(row.result_code).toBe(400);
    expect(row.total_tokens).toBe(0);
    expect(row.usage_missing).toBe(false);
    await awaitAccounting(modelId);
  });
});

// `settled` is what the accounting hangs off, so its contract is worth pinning
// directly: a bodiless streaming response has no tap to report completion, and
// a client that disconnects mid-stream still has to leave a row behind.
describe('proxy/upstream callOpenAI settled', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1', 'T', 'UTC')`);
  });

  async function seedKey(): Promise<string> {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-test',
      label: 'p',
    });
    return k.id;
  }

  test('settled resolves even when the streaming response has no body', async () => {
    const keyId = await seedKey();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const res = await callOpenAI({
      endpoint: 'https://api.example.com/v1/chat/completions',
      headers: {},
      body: { model: 'gpt-4o', stream: true },
      providerKeyId: keyId,
    });
    expect(res.stream).toBeUndefined();
    await expect(res.settled).resolves.toBeNull();
  });

  test('settled resolves with null when the client cancels the stream early', async () => {
    const keyId = await seedKey();
    fetchMock.mockResolvedValueOnce(
      new Response(sseStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'), {
        status: 200,
      })
    );

    const res = await callOpenAI({
      endpoint: 'https://api.example.com/v1/chat/completions',
      headers: {},
      body: { model: 'gpt-4o', stream: true },
      providerKeyId: keyId,
    });
    // Abandon the body the way a disconnected client would.
    await res.stream?.cancel();
    await expect(res.settled).resolves.toBeNull();
  });

  test('settled carries the usage once a streamed body is fully drained', async () => {
    const keyId = await seedKey();
    fetchMock.mockResolvedValueOnce(
      new Response(sseStream('data: {"usage":{"prompt_tokens":5,"completion_tokens":6}}\n\n', 'data: [DONE]\n\n'), {
        status: 200,
      })
    );

    const res = await callOpenAI({
      endpoint: 'https://api.example.com/v1/chat/completions',
      headers: {},
      body: { model: 'gpt-4o', stream: true },
      providerKeyId: keyId,
    });
    expect(await new Response(res.stream!).text()).toContain('[DONE]');
    await expect(res.settled).resolves.toEqual({ tokenIn: 5, tokenOut: 6 });
  });
});
