import { pool } from '../db/pool';
import { timezone } from '../org/timezone';

export interface AsrQuota {
  usedSecondsToday: number;
  remainingSecondsToday: number;
  limitSecondsToday: number;
}

/** Default daily cap when a provider's `config` does not set one. */
export const DEFAULT_ASR_DAILY_LIMIT_SECONDS = 600;

function resolveLimit(cfg: Record<string, unknown> | null | undefined): number {
  const raw = cfg?.limitSecondsToday;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_ASR_DAILY_LIMIT_SECONDS;
}

/**
 * Read today's usage for this user.
 *
 * The day boundary comes from `timezone.quotaWindowDate`, which resolves the
 * USER's zone first and falls back to the org's. That is deliberately not
 * "the org's day": a member travelling across the date line would otherwise
 * get two different quotas on the same calendar day, with the reset landing
 * at a different instant for each of them.
 */
export async function getAsrQuota(
  orgId: string,
  userId: string,
  providerConfig?: Record<string, unknown> | null,
): Promise<AsrQuota> {
  const limit = resolveLimit(providerConfig);
  const day = await resolveQuotaDay(userId);
  const r = await pool.query<{ used: string | number }>(
    `SELECT used_seconds AS used FROM asr_daily_usage
      WHERE org_id = $1 AND user_id = $2 AND day = $3`,
    [orgId, userId, day],
  );
  const used = Number(r.rows[0]?.used ?? 0);
  return {
    usedSecondsToday: used,
    remainingSecondsToday: Math.max(0, limit - used),
    limitSecondsToday: limit,
  };
}

/**
 * Add consumed seconds.
 *
 * The delta is carried as MILLISECONDS, not whole seconds: the relay flushes
 * every few seconds and a whole-second truncation per flush threw away a
 * sizeable share of real usage (a 5-second window of 200ms chunks measured
 * 4.96s and rounded to 4), which quietly loosened the daily cap by 10-20%.
 *
 * The column is seconds, so the remainder is carried in memory by the CALLER
 * and this function adds whatever whole seconds have accumulated; the caller
 * keeps the fraction for the next flush. `addAsrMilliseconds` exists for the
 * case where the caller wants the fractional part persisted exactly.
 */
export async function addAsrSeconds(orgId: string, userId: string, seconds: number): Promise<void> {
  const delta = Math.max(0, Math.floor(seconds));
  if (delta === 0) return;
  const day = await resolveQuotaDay(userId);
  await pool.query(
    `INSERT INTO asr_daily_usage(org_id, user_id, day, used_seconds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, user_id, day)
     DO UPDATE SET used_seconds = asr_daily_usage.used_seconds + EXCLUDED.used_seconds`,
    [orgId, userId, day, delta],
  );
}

/**
 * The quota day for a user, resolved ONCE per session rather than per flush.
 *
 * `timezone.quotaWindowDate` throws for a user row that no longer exists
 * (archived mid-session), so every caller must handle that: the relay used to
 * let it escape as an unhandled rejection, which terminates the whole server
 * process.
 */
export async function resolveQuotaDay(userId: string): Promise<string> {
  return timezone.quotaWindowDate(userId, new Date());
}
