import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';

import { getAsrQuota } from '../asr/quota';
import { asrProtocols, getAsrProvider } from '../asr/registry';
import { issueAsrTicket } from '../asr/ticket';
import type { ResolvedAsrConfig } from '../asr/types';
import { requireActiveMemberNumeric } from '../auth/requireActiveMember';
import { pool } from '../db/pool';
import { resolvePublicWsOrigin } from '../lib/publicOrigin';
import { typedModelSelection } from '../models/typedModelSelection';
import { AsrApiCode, type AsrLangType } from '../shared/asr/constants';
import { providerKeyVault } from '../vault/providerKeyVault';

export const asrRoutes = new Hono();

/** The desktop sends PCM16 at this rate; the adapter and the quota meter must
 *  agree with it or every frame is noise and every second is miscounted. */
const DEFAULT_SAMPLE_RATE = 16000;
const CHUNK_INTERVAL_MS = 200;
const MAX_SESSION_SECONDS = 60;
const MAX_CONCURRENT_SESSIONS = 1;
const TICKET_TTL_SECONDS = 60;

interface AsrProviderRow {
  id: string;
  provider: string;
  protocol: string;
  endpoint: string | null;
  config: Record<string, unknown> | null;
}

/**
 * The org's ASR provider, and the model it should run.
 *
 * The chain, and why it is this shape: the client asks for a session without
 * naming a model, so the server picks. The catalog is the source of truth
 * now — the `asr` default model wins, then the first enabled `asr` model, and
 * only when the org has no ASR catalog row at all does the old "earliest
 * created ASR key" behavior apply (which is what an org configured before the
 * catalog existed gets, and it must keep working).
 *
 * `model` is null on that last fallback: there is no catalog model to name,
 * and the adapter's stored `config.model` stays in charge.
 */
export async function resolveAsrProvider(
  orgId: string,
): Promise<{ row: AsrProviderRow; model: string | null } | null> {
  const selection = await typedModelSelection.select(orgId, 'asr', null);
  if (selection) {
    const r = await pool.query<AsrProviderRow>(
      `SELECT id, provider, protocol, endpoint, config
         FROM provider_keys
        WHERE id = $1 AND org_id = $2 AND enabled`,
      [selection.candidate.providerKeyId, orgId],
    );
    const row = r.rows[0];
    if (row) return { row, model: selection.candidate.model };
  }

  // The REGISTRY decides which protocols are ASR-capable, not a literal in
  // this route. Hard-coding 'realtime-asr' here would make every future ASR
  // dialect a code change, and would make the `getAsrProvider` check below
  // unreachable dead code.
  const protocols = asrProtocols();
  if (protocols.length === 0) return null;
  const r = await pool.query<AsrProviderRow>(
    `SELECT id, provider, protocol, endpoint, config
       FROM provider_keys
      WHERE org_id = $1 AND enabled AND protocol = ANY($2)
      ORDER BY created_at ASC
      LIMIT 1`,
    [orgId, protocols],
  );
  const row = r.rows[0];
  return row ? { row, model: null } : null;
}

asrRoutes.post('/api/asr/realtime/sessions', requireActiveMemberNumeric, async (c) => {
  const claims = c.get('claims');
  const orgId = claims.orgId;
  const userId = claims.sub;

  // The desktop posts form-urlencoded (langType=zh-CHS), not JSON.
  const body = await c.req.parseBody().catch(() => ({} as Record<string, string>));
  const langType = (typeof body.langType === 'string' ? body.langType : 'zh-CHS') as AsrLangType;

  const resolved = await resolveAsrProvider(orgId);
  if (!resolved) {
    return c.json({ code: AsrApiCode.ConfigInvalid, message: 'no asr provider configured' });
  }
  const { row } = resolved;
  if (!getAsrProvider(row.protocol)) {
    return c.json({
      code: AsrApiCode.ConfigInvalid,
      message: `no adapter registered for protocol ${row.protocol}`,
    });
  }

  const quota = await getAsrQuota(orgId, userId, row.config);
  if (quota.remainingSecondsToday <= 0) {
    return c.json({
      code: AsrApiCode.DailyLimitExceeded,
      message: 'daily asr quota exhausted',
    });
  }

  const apiKey = await providerKeyVault.getDecrypted(row.id).catch(() => null);
  if (!apiKey) {
    return c.json({ code: AsrApiCode.UpstreamAuthFailed, message: 'provider key unavailable' });
  }

  const cfg: ResolvedAsrConfig = {
    id: row.id,
    protocol: row.protocol,
    provider: row.provider,
    endpoint: row.endpoint,
    apiKey,
    config: row.config ?? {},
    sampleRate:
      typeof row.config?.sampleRate === 'number' ? row.config.sampleRate : DEFAULT_SAMPLE_RATE,
  };

  const requestId = randomUUID();
  const wsOrigin = resolvePublicWsOrigin(c);
  const ticket = await issueAsrTicket({
    orgId,
    userId,
    requestId,
    langType,
    providerKeyId: cfg.id,
    protocol: cfg.protocol,
    // The catalog's model, carried to the relay. Absent when the selection
    // fell back to "the first enabled ASR key" with no catalog row.
    ...(resolved.model ? { model: resolved.model } : {}),
  });

  return c.json({
    code: 0,
    data: {
      requestId,
      wsUrl: `${wsOrigin}/api/asr/realtime?ticket=${encodeURIComponent(ticket)}`,
      expiresInSeconds: TICKET_TTL_SECONDS,
      chunkIntervalMillis: CHUNK_INTERVAL_MS,
      maxSessionSeconds: MAX_SESSION_SECONDS,
      maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
      usedSecondsToday: quota.usedSecondsToday,
      remainingSecondsToday: quota.remainingSecondsToday,
      limitSecondsToday: quota.limitSecondsToday,
    },
  });
});

/**
 * The ASR models the desktop's picker renders.
 *
 * Same envelope as the media list: the qualified id, the default model, and
 * an empty list (not an error) when the org has none.
 */
asrRoutes.get('/api/asr/models', requireActiveMemberNumeric, async (c) => {
  const claims = c.get('claims');
  const candidates = await typedModelSelection.listCandidates(claims.orgId, 'asr');
  const defaultCandidate = await typedModelSelection.defaultCandidate(claims.orgId, 'asr');
  return c.json({
    code: 0,
    data: candidates.map((candidate) => ({
      modelId: candidate.qualifiedId,
      displayName: candidate.displayName ?? candidate.model,
      provider: candidate.provider,
      capabilities: candidate.types,
      parameterSpec: candidate.parameterSpec,
    })),
    defaultModel: defaultCandidate ? defaultCandidate.qualifiedId : null,
  });
});
