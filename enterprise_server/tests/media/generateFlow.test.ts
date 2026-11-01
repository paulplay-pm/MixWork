import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

/**
 * The media registry is stubbed so the upstream submit can be HELD OPEN.
 *
 * The bug this file pins down is a race between the generate route and the
 * media worker, and a race cannot be tested with a provider that answers
 * instantly: the whole window is the time the upstream takes to answer.
 */
const h = vi.hoisted(() => ({
  submit: async (_cfg: unknown, _p: unknown): Promise<unknown> => {
    throw new Error('submit not stubbed');
  },
  poll: async (_cfg: unknown, _id: string): Promise<unknown> => ({ status: 'queued' }),
  cancel: async (_cfg: unknown, _id: string): Promise<void> => {},
}));

vi.mock('../../src/media/registry', () => ({
  getMediaProvider: () => ({
    synchronous: false,
    submit: (cfg: unknown, p: unknown) => h.submit(cfg, p),
    poll: (cfg: unknown, id: string) => h.poll(cfg, id),
    cancel: (cfg: unknown, id: string) => h.cancel(cfg, id),
  }),
  mediaProtocols: () => ['image-gen', 'video-gen'],
}));

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import type { MediaSubmitResult } from '../../src/media/types';
import { createMediaWorker } from '../../src/media/worker';
import { mediaRoutes } from '../../src/routes/media';
import { encrypt } from '../../src/vault/crypto';

interface TaskRow {
  id: string;
  status: string;
  upstream_task_id: string | null;
  result: { resultUrls?: string[] } | null;
  error: { errorMessage?: string } | null;
}

interface TaskData {
  taskId?: string;
  status?: string;
  upstreamTaskId?: string;
  resultUrls?: string[];
  errorMessage?: string;
}

interface Envelope<T> {
  code?: number;
  data?: T;
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

function app(): Hono {
  const a = new Hono();
  a.route('/', mediaRoutes);
  return a;
}

async function seed(): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, status)
     VALUES ('u1','o1','u1','x','active')`,
  );
  await testPool.query(
    `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by,protocol,enabled,config)
     VALUES ('pk1','o1','minimax',$1,'u1','image-gen',true,'{"models":[{"modelId":"image-01"}]}'::jsonb)`,
    [encrypt('sk-minimax')],
  );
  // Generation routes by the model's catalog row, so the key alone is not
  // enough to make a task creatable.
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name, type, types, enabled)
     VALUES ('mc1','o1','pk1','minimax','image-01','Image 01','image',ARRAY['image-gen'],true)`,
  );
  return signToken({ sub: 'u1', orgId: 'o1', roles: ['org_admin'] });
}

const post = (token: string, path: string, body: unknown) =>
  app().request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function readTask(id: string): Promise<TaskRow> {
  const r = await testPool.query<TaskRow>(
    `SELECT id, status, upstream_task_id, result, error FROM media_tasks WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

/** The reserved row exists as soon as the route has inserted it. */
async function waitForTask(): Promise<TaskRow> {
  for (let i = 0; i < 200; i++) {
    const r = await testPool.query<TaskRow>(
      `SELECT id, status, upstream_task_id, result, error FROM media_tasks LIMIT 1`,
    );
    if (r.rows[0]) return r.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no media task was created');
}

/** A submit that only finishes when the test says so. */
function deferredSubmit(): { promise: Promise<MediaSubmitResult>; release: (r: MediaSubmitResult) => void } {
  let release!: (r: MediaSubmitResult) => void;
  const promise = new Promise<MediaSubmitResult>((resolve) => {
    release = resolve;
  });
  h.submit = async () => promise;
  return { promise, release };
}

describe('media generate：提交上游期间的竞态', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    h.submit = async () => {
      throw new Error('submit not stubbed');
    };
  });

  /**
   * The bug.
   *
   * The route reserved the task as 'queued' and only wrote the upstream id
   * after the submit returned. The worker claims 'queued' rows, so in that
   * window it claimed a task with no upstream id and failed it with "no
   * upstream task id". The route's later UPDATE set the status back to
   * 'succeeded' but left the `error` column, so a task that succeeded still
   * reported an error. And when the worker's failure landed after the
   * route's UPDATE, the task was 'failed' while the upstream render was
   * still running — and the worker only polls 'queued' rows, so that video
   * was never collected again.
   */
  test('提交上游期间任务处于 submitting，worker 不会认领它', async () => {
    const token = await seed();
    const { release } = deferredSubmit();

    const pending = post(token, '/api/media/images/generate', {
      model: 'image-01', type: 'image', prompt: 'a cat', params: {},
    });

    const reserved = await waitForTask();
    expect(reserved.status).toBe('submitting');
    expect(reserved.upstream_task_id).toBeNull();

    // A worker pass inside that window must leave the task alone.
    const worker = createMediaWorker({ getProvider: () => undefined, resolveConfig: async () => null });
    expect(await worker.runOnce()).toBe(0);
    const during = await readTask(reserved.id);
    expect(during.status).toBe('submitting');
    expect(during.error).toBeNull();

    release({ upstreamTaskId: 'up1', immediateResult: { resultUrls: ['https://cdn/a.png'] } });
    const body = await json<Envelope<TaskData>>(await pending);
    expect(body.data?.status).toBe('succeeded');

    const done = await readTask(reserved.id);
    expect(done.status).toBe('succeeded');
    // The regression: a succeeded task must not carry an error.
    expect(done.error).toBeNull();
    expect(done.result?.resultUrls).toEqual(['https://cdn/a.png']);
  });

  test('同步上游返回后任务 succeeded 且不带 error', async () => {
    const token = await seed();
    h.submit = async () => ({
      upstreamTaskId: 'up1',
      immediateResult: { resultUrls: ['https://cdn/a.png'] },
    });
    const body = await json<Envelope<TaskData>>(await post(token, '/api/media/images/generate', {
      model: 'image-01', type: 'image', prompt: 'a cat', params: {},
    }));
    expect(body.data?.status).toBe('succeeded');
    expect(body.data?.errorMessage).toBe('');

    const row = await readTask(String(body.data?.taskId));
    expect(row.status).toBe('succeeded');
    expect(row.error).toBeNull();
  });

  test('异步上游返回后任务 queued 且带 upstream id，worker 之后能认领', async () => {
    const token = await seed();
    h.submit = async () => ({ upstreamTaskId: 'up1' });
    const body = await json<Envelope<TaskData>>(await post(token, '/api/media/images/generate', {
      model: 'image-01', type: 'image', prompt: 'a cat', params: {},
    }));
    expect(body.data?.status).toBe('queued');
    expect(body.data?.upstreamTaskId).toBe('up1');

    const row = await readTask(String(body.data?.taskId));
    expect(row.status).toBe('queued');
    expect(row.upstream_task_id).toBe('up1');
    expect(row.error).toBeNull();
  });

  // The response of a failed task still names the model-selection outcome
  // (which model actually ran, and why) — that is what explains a
  // substitution to the user. What must NOT linger is a RESULT: no URLs.
  test('提交失败 → failed + errorMessage，且不残留 result', async () => {
    const token = await seed();
    h.submit = async () => {
      throw new Error('upstream exploded');
    };
    const body = await json<Envelope<TaskData>>(await post(token, '/api/media/images/generate', {
      model: 'image-01', type: 'image', prompt: 'a cat', params: {},
    }));
    expect(body.data?.status).toBe('failed');
    expect(body.data?.errorMessage).toBe('upstream exploded');

    const row = await readTask(String(body.data?.taskId));
    expect(row.status).toBe('failed');
    expect(row.error?.errorMessage).toBe('upstream exploded');
    expect(row.result?.resultUrls).toBeUndefined();
  });

  test('取消与提交竞争 → cancelled 胜出，upstream id 仍被记录', async () => {
    const token = await seed();
    const { release } = deferredSubmit();

    const pending = post(token, '/api/media/images/generate', {
      model: 'image-01', type: 'image', prompt: 'a cat', params: {},
    });
    const reserved = await waitForTask();

    const cancelled = await post(token, `/api/media/images/tasks/${reserved.id}/cancel`, {});
    expect((await json<Envelope<TaskData>>(cancelled)).data?.status).toBe('cancelled');

    // The submit finishes after the cancel: the task must stay cancelled.
    release({ upstreamTaskId: 'up1', immediateResult: { resultUrls: ['https://cdn/a.png'] } });
    await pending;

    const row = await readTask(reserved.id);
    expect(row.status).toBe('cancelled');
    expect(row.upstream_task_id).toBe('up1');
  });
});
