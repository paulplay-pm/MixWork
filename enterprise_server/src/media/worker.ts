import { pool } from '../db/pool';
import { providerKeyVault } from '../vault/providerKeyVault';
import { getMediaProvider } from './registry';
import type { MediaPollResult, ResolvedMediaConfig } from './types';

export interface MediaWorkerDeps {
  /** Overridable so the worker can be tested without a provider or a vault. */
  getProvider?: (protocol: string) => ReturnType<typeof getMediaProvider>;
  resolveConfig?: (providerKeyId: string) => Promise<ResolvedMediaConfig | null>;
  now?: () => Date;
  /** How long a task may run before the server gives up on it, per kind. */
  expiryMs?: { image: number; video: number };
}

interface ClaimedTask {
  id: string;
  org_id: string;
  kind: 'image' | 'video';
  model: string;
  provider: string | null;
  provider_key_id: string | null;
  upstream_task_id: string | null;
  prompt: Record<string, unknown>;
}

/**
 * Advance queued media tasks by one step.
 *
 * Three properties this has to have, and each one is a bug if it doesn't:
 *
 *  - **Multi-instance safety.** The claim is `FOR UPDATE SKIP LOCKED`, so two
 *    replicas polling at the same instant cannot both take the same task.
 *    A plain `SELECT ... LIMIT 1` would run every task N times.
 *  - **Idempotent terminal writes.** A poll that lands AFTER a cancel must not
 *    resurrect the task, so the status write is conditional on the task still
 *    being `running`. Losing a late result is fine; undoing a cancellation is
 *    not.
 *  - **Expiry.** The desktop has its own timeouts; the server has to give up
 *    too, or a task whose upstream never answers stays `running` forever and
 *    the client polls until it dies.
 */
export function createMediaWorker(deps: MediaWorkerDeps = {}) {
  const getProvider = deps.getProvider ?? getMediaProvider;
  const resolveConfig = deps.resolveConfig ?? resolveConfigFromProviderKey;
  const now = deps.now ?? (() => new Date());
  const expiryMs = deps.expiryMs ?? { image: 30 * 60 * 1000, video: 10 * 60 * 60 * 1000 };

  async function runOnce(): Promise<number> {
    const claimed = await pool.query<ClaimedTask>(
      `UPDATE media_tasks SET status = 'running', updated_at = NOW()
        WHERE id = (
          SELECT id FROM media_tasks
           WHERE status = 'queued'
           ORDER BY updated_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING id, org_id, kind, model, provider, provider_key_id, upstream_task_id, prompt`,
    );
    const task = claimed.rows[0];
    if (!task) return 0;

    if (!task.upstream_task_id) {
      // Nothing to poll (a synchronous provider would have finished inline).
      await failTask(task.id, 'no upstream task id');
      return 1;
    }

    // The provider ROW id, not the vendor slug: `provider` is a display name
    // and several rows can share it, so resolving by it matched no row and
    // failed EVERY async task within five seconds of it being created.
    const cfg = await resolveConfig(task.provider_key_id ?? '');
    if (!cfg) {
      await failTask(task.id, 'provider not configured');
      return 1;
    }
    const provider = getProvider(cfg.protocol);
    if (!provider) {
      await failTask(task.id, `no adapter for ${cfg.protocol}`);
      return 1;
    }

    let result: MediaPollResult;
    try {
      result = await provider.poll(cfg, task.upstream_task_id);
    } catch (error) {
      await failTask(task.id, error instanceof Error ? error.message : 'poll failed');
      return 1;
    }

    if (result.status === 'succeeded') {
      await finishTask(task.id, { resultUrls: result.resultUrls ?? [] });
    } else if (result.status === 'failed' || result.status === 'cancelled') {
      await failTask(task.id, result.errorMessage ?? result.status);
    } else {
      // Still in flight: put it back so the next pass picks it up. The write is
      // conditional on `running`, so a cancel that raced us wins.
      await pool.query(
        `UPDATE media_tasks SET status = 'queued', updated_at = NOW()
          WHERE id = $1 AND status = 'running'`,
        [task.id],
      );
    }
    return 1;
  }

  async function failTask(id: string, message: string): Promise<void> {
    // `result = NULL`: the two columns are mutually exclusive. A task that
    // carries both a result and an error is reported as failed by the desktop
    // while still showing the stale result urls.
    await pool.query(
      `UPDATE media_tasks
          SET status = 'failed', error = $2::jsonb, result = NULL, updated_at = NOW()
        WHERE id = $1 AND status IN ('queued','running')`,
      [id, JSON.stringify({ errorMessage: message })],
    );
  }

  async function finishTask(id: string, result: { resultUrls: string[] }): Promise<void> {
    // `error = NULL` for the same reason as failTask's `result = NULL`: the
    // two columns are mutually exclusive.
    await pool.query(
      `UPDATE media_tasks
          SET status = 'succeeded', result = $2::jsonb, error = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify(result)],
    );
  }

  /** Fail tasks that have been running past the expiry for THEIR kind.
   *
   *  A single 30-minute ceiling failed legitimate long video renders while
   *  the client was still waiting on them. */
  async function expireStaleTasks(): Promise<number> {
    const nowMs = now().getTime();
    let total = 0;
    for (const kind of ['image', 'video'] as const) {
      const cutoff = new Date(nowMs - expiryMs[kind]);
      const r = await pool.query(
        `UPDATE media_tasks
            SET status = 'failed', error = $1::jsonb, result = NULL, updated_at = NOW()
          WHERE status IN ('queued','running','submitting') AND kind = $3 AND created_at < $2`,
        [JSON.stringify({ errorMessage: 'task expired' }), cutoff, kind],
      );
      total += r.rowCount ?? 0;
    }
    return total;
  }

  return { runOnce, expireStaleTasks };
}

async function resolveConfigFromProviderKey(
  providerKeyId: string,
): Promise<ResolvedMediaConfig | null> {
  if (!providerKeyId) return null;
  const r = await pool.query<{
    id: string;
    provider: string;
    protocol: string;
    endpoint: string | null;
    config: Record<string, unknown> | null;
  }>(
    `SELECT id, provider, protocol, endpoint, config
       FROM provider_keys WHERE id = $1 AND enabled`,
    [providerKeyId],
  );
  const row = r.rows[0];
  if (!row) return null;
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
