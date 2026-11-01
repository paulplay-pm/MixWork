import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';

import { requireActiveMemberNumeric } from '../auth/requireActiveMember';
import { pool } from '../db/pool';
import { getMediaProvider } from '../media/registry';
import type { MediaGenerateType, MediaModelDescriptor, ResolvedMediaConfig } from '../media/types';
import { typedModelSelection } from '../models/typedModelSelection';
import { providerKeyVault } from '../vault/providerKeyVault';

export const mediaRoutes = new Hono();

/**
 * How long a task may run before the server gives up on it, per kind.
 *
 * The desktop has its own timeouts (30 min for images, 10 h for video) and it
 * reads `execution_expires_after` as a NUMBER OF SECONDS (`typeof x ===
 * 'number' ? x * 1000 : DEFAULT`). Emitting an ISO string there silently
 * fell back to the desktop's 48-hour default, so the server's expiry was dead
 * data and a legitimate long video render got failed at 30 minutes.
 */
const TASK_EXPIRY_MS: Record<'image' | 'video', number> = {
  image: 30 * 60 * 1000,
  video: 10 * 60 * 60 * 1000,
};

const GENERATE_TYPES: ReadonlySet<string> = new Set(['image', 'video', 't2v', 'i2v', 'r2v']);

interface ProviderRow {
  id: string;
  provider: string;
  protocol: string;
  endpoint: string | null;
  config: Record<string, unknown> | null;
}

async function resolveConfig(row: ProviderRow): Promise<ResolvedMediaConfig | null> {
  const apiKey = await providerKeyVault.getDecrypted(row.id).catch(() => null);
  if (!apiKey) return null;
  return {
    id: row.id,
    protocol: row.protocol,
    provider: row.provider,
    endpoint: row.endpoint,
    apiKey,
    config: row.config ?? {},
  };
}

async function loadTask(orgId: string, taskId: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query<{
    id: string;
    kind: string;
    model: string;
    status: string;
    upstream_task_id: string | null;
    provider: string | null;
    result: Record<string, unknown> | null;
    error: Record<string, unknown> | null;
    idempotency_key: string | null;
    created_at: Date;
  }>(
    `SELECT id, kind, model, status, upstream_task_id, provider, result, error,
            idempotency_key, created_at
       FROM media_tasks WHERE id = $1 AND org_id = $2`,
    [taskId, orgId],
  );
  return (r.rows[0] as unknown as Record<string, unknown>) ?? null;
}

/** The shape the desktop reads. Field names are the desktop's, verbatim. */
function taskWire(task: Record<string, unknown>): Record<string, unknown> {
  const result = (task.result ?? {}) as Record<string, unknown>;
  const error = (task.error ?? {}) as Record<string, unknown>;
  const created = task.created_at as Date | undefined;
  const kind = (task.kind === 'video' ? 'video' : 'image') as 'image' | 'video';
  return {
    taskId: task.id,
    upstreamTaskId: task.upstream_task_id ?? '',
    status: task.status,
    model: task.model,
    // The desktop reads this on the status and background-poll paths, where
    // there is no fallback — without it the completion notice names the
    // canonical id instead of the upstream model that actually ran.
    upstreamModel:
      typeof result.upstreamModel === 'string' ? result.upstreamModel : (task.model as string),
    resultUrls: Array.isArray(result.resultUrls) ? (result.resultUrls as string[]) : [],
    errorMessage: typeof error.errorMessage === 'string' ? error.errorMessage : '',
    modelSelectionReason:
      typeof result.modelSelectionReason === 'string' ? result.modelSelectionReason : '',
    quotaRemaining: typeof result.quotaRemaining === 'number' ? result.quotaRemaining : null,
    metadata: {
      // SECONDS, not an ISO string: the desktop does
      // `typeof x === 'number' ? x * 1000 : DEFAULT`.
      execution_expires_after: created
        ? Math.ceil((created.getTime() + TASK_EXPIRY_MS[kind]) / 1000)
        : null,
    },
  };
}

/** `images` / `videos` → the model TYPE that serves that kind. */
function modelTypeForKind(kind: 'images' | 'videos'): 'image-gen' | 'video-gen' {
  return kind === 'images' ? 'image-gen' : 'video-gen';
}

/**
 * The model list the desktop's picker renders.
 *
 * `modelId` is the QUALIFIED id (`minimax/image-01`): several vendors can
 * publish the same bare model name, and the qualified id is the only one the
 * generate route can resolve back to a single row.
 *
 * An org with no models of this type answers `code: 0` with an empty list —
 * "no image models configured" is a normal state, not a server error.
 */
mediaRoutes.get('/api/media/:kind/models', requireActiveMemberNumeric, async (c) => {
  const claims = c.get('claims');
  const kind = c.req.param('kind');
  if (kind !== 'images' && kind !== 'videos') {
    return c.json({ code: 400, message: 'unknown media kind' }, 400);
  }
  const type = modelTypeForKind(kind);
  const candidates = await typedModelSelection.listCandidates(claims.orgId, type);
  const defaultCandidate = await typedModelSelection.defaultCandidate(claims.orgId, type);
  return c.json({
    code: 0,
    data: candidates.map((candidate): MediaModelDescriptor => ({
      modelId: candidate.qualifiedId,
      displayName: candidate.displayName ?? candidate.model,
      provider: candidate.provider,
      capabilities: candidate.types,
      parameterSpec: candidate.parameterSpec,
    })),
    defaultModel: defaultCandidate ? defaultCandidate.qualifiedId : null,
  });
});

mediaRoutes.post('/api/media/:kind/generate', requireActiveMemberNumeric, async (c) => {
  const claims = c.get('claims');
  const kind = c.req.param('kind');
  if (kind !== 'images' && kind !== 'videos') {
    return c.json({ code: 400, message: 'unknown media kind' }, 400);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    model?: string;
    type?: string;
    prompt?: string;
    params?: Record<string, unknown>;
  };
  const type = (body.type ?? (kind === 'images' ? 'image' : 'video')) as MediaGenerateType;
  if (!GENERATE_TYPES.has(type)) {
    return c.json({ code: 400, message: 'unknown generate type' }, 400);
  }
  const idempotencyKey = c.req.header('idempotency-key') ?? null;

  // WHICH VENDOR RUNS THIS IS DECIDED BY THE MODEL, NOT BY KEY ORDER.
  //
  // Two vendors can both serve image generation; picking the earliest key
  // would send a request for vendor B's model to vendor A, which either
  // 404s upstream or bills the wrong account. `select` resolves the model
  // to the row that owns it and falls back to the type's default when the
  // client names nothing usable.
  const modelType = modelTypeForKind(kind);
  const selection = await typedModelSelection.select(claims.orgId, modelType, body.model ?? null);
  if (!selection) {
    return c.json({ code: 400, message: 'no_provider_configured' }, 400);
  }
  const { candidate } = selection;

  const providerRow = await pool.query<ProviderRow>(
    `SELECT id, provider, protocol, endpoint, config
       FROM provider_keys
      WHERE id = $1 AND org_id = $2 AND enabled`,
    [candidate.providerKeyId, claims.orgId],
  );
  const row = providerRow.rows[0];
  if (!row) {
    return c.json({ code: 400, message: 'no_provider_configured' }, 400);
  }
  const cfg = await resolveConfig(row);
  if (!cfg) {
    return c.json({ code: 41400, message: 'provider key unavailable' });
  }
  const provider = getMediaProvider(cfg.protocol);
  if (!provider) {
    return c.json({ code: 41400, message: `no adapter for ${cfg.protocol}` });
  }

  const taskId = randomUUID();
  const now = new Date();
  const mediaKind = kind === 'images' ? 'image' : 'video';

  // RESERVE THE ROW BEFORE SUBMITTING UPSTREAM.
  //
  // Checking for an existing key and then inserting afterwards left a window in
  // which two concurrent requests with the same Idempotency-Key both missed
  // the lookup, BOTH submitted upstream (both billed), and then one of them
  // hit the unique index — and the failure path inserted again, hitting it
  // again, so the request 500'd with no task row for a generation that had
  // already been charged for.
  //
  // `ON CONFLICT DO NOTHING RETURNING` makes the reservation atomic: exactly
  // one request wins and submits; the other reads back the winner's row.
  //
  // The reserved status is 'submitting', NOT 'queued': the worker claims
  // 'queued' rows, and a claim landing between this INSERT and the submit's
  // return would fail a task that has no upstream id yet ("no upstream task
  // id"). The worker does not claim 'submitting' rows, so the task only
  // becomes pollable once the upstream id is actually stored.
  const reserved = await pool.query<{ id: string }>(
    `INSERT INTO media_tasks(id, org_id, user_id, kind, model, prompt, status, provider,
                              provider_key_id, idempotency_key, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,'submitting',$7,$8,$9,$10,$10)
     ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      taskId,
      claims.orgId,
      claims.sub,
      mediaKind,
      candidate.qualifiedId,
      JSON.stringify({ type, prompt: body.prompt ?? '', params: body.params ?? {} }),
      row.provider,
      row.id,
      idempotencyKey,
      now,
    ],
  );
  if (!reserved.rows[0]) {
    // Someone else holds this idempotency key: return THEIR task, not an error.
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM media_tasks WHERE org_id = $1 AND idempotency_key = $2`,
      [claims.orgId, idempotencyKey],
    );
    const task = existing.rows[0] ? await loadTask(claims.orgId, existing.rows[0].id) : null;
    if (task) return c.json({ code: 0, data: taskWire(task) });
  }
  try {
    const submitted = await provider.submit(cfg, {
      model: candidate.model,
      type,
      prompt: body.prompt ?? '',
      params: body.params ?? {},
    });

    const immediate = submitted.immediateResult;
    const status = immediate ? 'succeeded' : 'queued';
    // The row was reserved above, so this UPDATES it.
    //
    // `error = NULL`: a task that succeeded must not carry an error, even one
    // left over from an earlier attempt on the same row.
    //
    // The status transition only happens if the row is still 'submitting'. A
    // cancel that raced this submit wins, and the upstream id is recorded
    // either way so it is not lost.
    await pool.query(
      `UPDATE media_tasks
          SET upstream_task_id = $3,
              result = $4::jsonb,
              error = NULL,
              status = CASE WHEN status = 'submitting' THEN $2::text ELSE status END,
              updated_at = NOW()
        WHERE id = $1`,
      [
        taskId,
        status,
        submitted.upstreamTaskId,
        JSON.stringify(
          immediate
            ? {
                resultUrls: immediate.resultUrls,
                upstreamModel: candidate.model,
                modelSelectionReason: selection.reason,
              }
            : { upstreamModel: candidate.model, modelSelectionReason: selection.reason },
        ),
      ],
    );
  } catch (error) {
    // Conditional on 'submitting' for the same reason as the success path: a
    // cancel that raced the submit keeps the cancelled status, and a task
    // that already carries a result does not get one replaced by an error.
    //
    // `result` keeps the SELECTION metadata (no `resultUrls`): a request that
    // was answered with the default model because the one it named was gone
    // then failed upstream, and the reason is exactly what explains the
    // failure to the user. A failed task never carries URLs.
    await pool.query(
      `UPDATE media_tasks
          SET status = 'failed', error = $2::jsonb, result = $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND status = 'submitting'`,
      [
        taskId,
        JSON.stringify({
          errorMessage: error instanceof Error ? error.message : 'generation failed',
        }),
        JSON.stringify({
          upstreamModel: candidate.model,
          modelSelectionReason: selection.reason,
        }),
      ],
    );
  }

  const task = await loadTask(claims.orgId, taskId);
  return c.json({
    code: 0,
    data: taskWire(task ?? { id: taskId, status: 'failed', model: candidate.qualifiedId }),
  });
});

mediaRoutes.get('/api/media/:kind/tasks/:taskId', requireActiveMemberNumeric, async (c) => {
  const claims = c.get('claims');
  const task = await loadTask(claims.orgId, c.req.param('taskId'));
  if (!task) {
    return c.json({ code: 404, message: 'task not found' }, 404);
  }
  return c.json({ code: 0, data: taskWire(task) });
});

mediaRoutes.post('/api/media/:kind/tasks/:taskId/cancel', requireActiveMemberNumeric, async (c) => {
  const claims = c.get('claims');
  const taskId = c.req.param('taskId');
  const task = await loadTask(claims.orgId, taskId);
  if (!task) {
    return c.json({ code: 404, message: 'task not found' }, 404);
  }
  const status = String(task.status);
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    // Already terminal: cancel is a no-op, not an error. The desktop may poll
    // and cancel in either order.
    return c.json({ code: 0, data: taskWire(task) });
  }
  // Only the transition is conditional, so a late worker poll cannot resurrect
  // a cancelled task.
  await pool.query(
    `UPDATE media_tasks SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND org_id = $2 AND status IN ('queued','running','submitting')`,
    [taskId, claims.orgId],
  );
  const after = await loadTask(claims.orgId, taskId);
  return c.json({ code: 0, data: taskWire(after ?? task) });
});
