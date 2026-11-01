import type { IncomingMessage } from 'node:http';

import type { WebSocket } from 'ws';

import { pool } from '../db/pool';
import { AsrApiCode } from '../shared/asr/constants';
import { providerKeyVault } from '../vault/providerKeyVault';
import { addAsrSeconds, getAsrQuota, resolveQuotaDay } from './quota';
import { getAsrProvider } from './registry';
import { redeemAsrTicket } from './ticket';
import type {
  AsrProvider,
  AsrRecognitionEnvelope,
  AsrStream,
  ResolvedAsrConfig,
} from './types';

/** The desktop prefixes a 44-byte WAV header to its FIRST audio frame only.
 *  Forwarding it to an upstream that expects raw PCM16 injects a header as if
 *  it were audio, and inflates the metered duration by one frame. */
const WAV_HEADER_BYTES = 44;

/** `RIFF` — the first four bytes of a WAV header.
 *
 *  The header is only stripped when the first frame actually LOOKS like WAV
 *  AND the upstream wants raw PCM. A client that sends raw PCM16 from the
 *  start would otherwise lose its first 44 bytes of audio (and 1.4ms of quota)
 *  to a header that was never there. */
const WAV_MAGIC = Buffer.from('RIFF', 'ascii');

const METER_FLUSH_INTERVAL_MS = 5_000;

/** The server's own ceiling on one session, matching the client's 60s cap. */
const MAX_SESSION_MS = 60_000;

/**
 * Bounds on what may be buffered while the session is being set up.
 *
 * The buffer is client-controlled: the client starts streaming the moment the
 * handshake completes, and the relay is still doing real I/O. Without a cap,
 * a client could push megabytes into that window.
 */
const MAX_PENDING_FRAMES = 64;
const MAX_PENDING_BYTES = 1024 * 1024;

export interface AsrRelayDeps {
  /** Overridable so the relay can be tested without a network or a vault. */
  getProvider?: (protocol: string) => AsrProvider | undefined;
  resolveConfig?: (providerKeyId: string, orgId: string) => Promise<ResolvedAsrConfig | null>;
  addSeconds?: (orgId: string, userId: string, seconds: number) => Promise<void>;
  getQuota?: (
    orgId: string,
    userId: string,
    config?: Record<string, unknown> | null,
  ) => Promise<{
    usedSecondsToday: number;
    remainingSecondsToday: number;
    limitSecondsToday: number;
  }>;
  /**
   * Re-check that the member is still active when the socket opens. The
   * session endpoint checked a moment earlier; a revoked member must not get
   * a live audio stream just because their ticket was minted first.
   */
  isMemberActive?: (userId: string) => Promise<boolean>;
  /** Milliseconds between quota writes. */
  flushIntervalMs?: number;
  /** In-flight session count, for `maxConcurrentSessions`. */
  countActiveSessions?: (userId: string) => number;
}

/**
 * The ASR relay.
 *
 * The SERVER holds the upstream connection and the upstream key; the client
 * only ever sees this server's socket. That is what makes the daily quota
 * enforceable — the server counts the audio it actually forwarded — and it is
 * why the desktop never has to hold a provider credential.
 */
export function createAsrRelay(deps: AsrRelayDeps = {}) {
  const getProvider = deps.getProvider ?? getAsrProvider;
  const resolveConfig = deps.resolveConfig ?? resolveAsrConfigFromProviderKey;
  const addSeconds = deps.addSeconds ?? addAsrSeconds;
  const getQuotaFn =
    deps.getQuota ??
    ((orgId: string, userId: string, config?: Record<string, unknown> | null) =>
      getAsrQuota(orgId, userId, config));
  const isMemberActive = deps.isMemberActive ?? defaultIsMemberActive;
  const flushIntervalMs = deps.flushIntervalMs ?? METER_FLUSH_INTERVAL_MS;

  /** Live sessions per user, for `maxConcurrentSessions`. */
  const activeSessions = new Map<string, number>();
  const countActiveSessions =
    deps.countActiveSessions ?? ((userId: string): number => activeSessions.get(userId) ?? 0);

  async function handleConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    let sessionUserId: string | null = null;
    let stream: AsrStream | null = null;
    /** The client's socket is gone. */
    let socketClosed = false;
    /** The relay has finished with this session (terminal state). */
    let closed = false;
    /** The concurrent-session slot was taken, so it must be returned. */
    let slotTaken = false;
    let released = false;
    /** The quota meter's interval, once the session is open. */
    let meter: ReturnType<typeof setInterval> | null = null;
    /** The quota flush, once the session is open. */
    let flushQuota: (() => Promise<void>) | null = null;
    /** The frame handler, once the upstream session is open. */
    let handleFrame: ((buf: Buffer, isBinary: boolean) => void) | null = null;
    /**
     * Frames that arrived before the upstream session was open.
     *
     * The client starts streaming the moment the handshake completes, while
     * the relay is still doing real I/O — ticket redemption, the member
     * check, the provider lookup, the quota read, the upstream connect.
     * `ws` emits 'message' whether or not anyone is listening, so a frame
     * that arrived in that window used to be dropped on the floor, taking
     * the WAV header with it.
     */
    const pendingFrames: Array<{ buf: Buffer; isBinary: boolean }> = [];
    let pendingBytes = 0;

    const release = (): void => {
      if (released || !slotTaken || !sessionUserId) return;
      released = true;
      releaseSession(sessionUserId);
    };

    const stopMeter = (): void => {
      if (meter === null) return;
      clearInterval(meter);
      meter = null;
    };

    const toBuffer = (data: Buffer | ArrayBuffer | Buffer[]): Buffer => {
      if (Array.isArray(data)) {
        return Buffer.concat(data);
      }
      if (Buffer.isBuffer(data)) {
        return data;
      }
      return Buffer.from(data as ArrayBuffer);
    };

    // The socket listeners are attached BEFORE any of the setup work below.
    // The setup is real I/O and the client is already streaming, so two
    // things used to go wrong in that window:
    //
    //  - a frame that arrived in it was DROPPED, because `ws` emits 'message'
    //    whether or not anyone is listening;
    //  - a client that disconnected in it left the concurrent-session slot
    //    raised, so `maxConcurrentSessions` locked that user out of voice
    //    input until the server process restarted.
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const buf = toBuffer(data);
      if (!handleFrame) {
        pendingBytes += buf.length;
        if (pendingFrames.length >= MAX_PENDING_FRAMES || pendingBytes > MAX_PENDING_BYTES) {
          // The setup window is short. A client that floods it is either
          // broken or trying to make the server buffer without limit.
          closeWithError(
            ws,
            AsrApiCode.AudioInvalid,
            'too much audio buffered before the session was ready',
          );
          return;
        }
        pendingFrames.push({ buf, isBinary });
        return;
      }
      handleFrame(buf, isBinary);
    });

    ws.on('close', () => {
      socketClosed = true;
      closed = true;
      pendingFrames.length = 0;
      stopMeter();
      release();
      try {
        stream?.close();
      } catch {
        // Already closed.
      }
      void flushQuota?.().catch(() => undefined);
    });

    try {
      const ticket = new URL(request.url ?? '', 'http://localhost').searchParams.get('ticket');
      if (!ticket) {
        closeWithError(ws, AsrApiCode.Unauthorized, 'missing ticket');
        return;
      }

      const claims = await redeemAsrTicket(ticket);
      if (!claims) {
        closeWithError(ws, AsrApiCode.Unauthorized, 'invalid ticket');
        return;
      }
      sessionUserId = claims.userId;

      if (!(await isMemberActive(claims.userId))) {
        closeWithError(ws, AsrApiCode.Unauthorized, 'not a member');
        return;
      }

      if (countActiveSessions(claims.userId) >= 1) {
        // `maxConcurrentSessions: 1` is advertised to the client, so it has to
        // be real here. A single-use ticket only stops ONE socket per ticket;
        // without a live count a client could request N sessions and open N
        // upstream streams, each billed.
        closeWithError(ws, AsrApiCode.UpstreamError, 'too many concurrent sessions');
        return;
      }

      const resolved = await resolveConfig(claims.providerKeyId, claims.orgId);
      if (!resolved) {
        closeWithError(ws, AsrApiCode.ConfigInvalid, 'provider not configured');
        return;
      }
      // The catalog picked this session's model, and the ticket carried it
      // here; the stored `config.model` may be stale (the admin renamed the
      // model, or the default moved to another vendor). A NEW object, not a
      // mutation: `resolved` can be a shared constant in tests, and mutating
      // it would leak one session's model into the next.
      const cfg = claims.model
        ? { ...resolved, config: { ...resolved.config, model: claims.model } }
        : resolved;

      const provider = getProvider(cfg.protocol);
      if (!provider) {
        closeWithError(ws, AsrApiCode.ConfigInvalid, `no adapter for ${cfg.protocol}`);
        return;
      }

      const quota = await getQuotaFn(claims.orgId, claims.userId, cfg.config);
      if (quota.remainingSecondsToday <= 0) {
        closeWithError(ws, AsrApiCode.DailyLimitExceeded, 'daily quota exhausted');
        return;
      }

      // The quota DAY is resolved once, here. Recomputing it per flush splits a
      // session that crosses local midnight across two days, and the lookup
      // throws for a user row that was archived mid-session.
      try {
        await resolveQuotaDay(claims.userId);
      } catch (error) {
        console.warn('[ASR] could not resolve the quota day', error);
      }

      // The client may have gone while the checks above ran. Taking the slot
      // now would leak it: nobody would ever return it.
      if (socketClosed) return;

      activeSessions.set(claims.userId, countActiveSessions(claims.userId) + 1);
      slotTaken = true;
      try {
        stream = await provider.openStream(cfg, { langType: claims.langType });
      } catch (error) {
        release();
        closeWithError(
          ws,
          AsrApiCode.UpstreamError,
          error instanceof Error ? error.message : 'upstream open failed',
        );
        return;
      }

      const session = stream;
      let forwardedBytes = 0;
      /** Un-flushed bytes, carried across flushes so no fraction is lost. */
      let unflushedBytes = 0;
      let firstFrame = true;
      let persistedSeconds = 0;
      const startedAt = Date.now();

      const flush = async (): Promise<void> => {
        if (unflushedBytes === 0) return;
        const bytes = unflushedBytes;
        unflushedBytes = 0;
        // Bytes → seconds at the configured rate. The remainder is NOT
        // dropped: truncating every flush threw away a tenth of everyone's
        // real usage, which quietly loosened the daily cap.
        const exact = bytes / (cfg.sampleRate * 2);
        persistedSeconds += exact;
        const whole = Math.floor(persistedSeconds);
        const delta = whole - Math.floor(persistedSeconds - exact);
        if (delta > 0) await addSeconds(claims.orgId, claims.userId, delta);
      };
      flushQuota = flush;

      meter = setInterval(() => {
        // Every void-ed promise needs a catch: a rejection here would be an
        // unhandled rejection, which terminates the whole server process and
        // takes chat, media and admin down with it.
        void flush().catch((error) => {
          console.warn('[ASR] quota flush failed', error);
        });
      }, flushIntervalMs);

      const terminate = (code: number, message: string): void => {
        if (closed) return;
        closed = true;
        stopMeter();
        release();
        // The upstream stream must be closed on EVERY terminal path. Leaving it
        // open keeps a billed audio connection alive with nobody listening.
        try {
          session.close();
        } catch (error) {
          console.warn('[ASR] upstream close failed', error);
        }
        closeWithError(ws, code, message);
      };

      session.on('recognition', (envelope: AsrRecognitionEnvelope) => {
        if (!closed) ws.send(JSON.stringify(envelope));
      });
      session.on('closed', () => {
        if (closed) return;
        closed = true;
        stopMeter();
        release();
        void flush()
          .catch((error) => console.warn('[ASR] quota flush failed', error))
          .finally(() => ws.close());
      });
      session.on('error', (code, message) => {
        terminate(code, message ?? 'upstream error');
      });

      handleFrame = (buf: Buffer, isBinary: boolean): void => {
        if (closed) return;

        if (!isBinary) {
          // Control frame. The desktop's end-of-stream signal is
          // `{"end":"true"}`; it is a distinct verb from close, because the
          // client waits for trailing recognition after it.
          const text = buf.toString('utf8');
          try {
            const parsed = JSON.parse(text) as { end?: unknown };
            if (parsed?.end === 'true' || parsed?.end === true) {
              session.finish();
              return;
            }
          } catch {
            // Not JSON: nothing to act on.
          }
          return;
        }

        let pcm = buf;
        if (firstFrame) {
          firstFrame = false;
          // Only a RAW-PCM upstream wants the header gone. A WAV upstream
          // decodes the container, and stripping it would send a header as
          // audio.
          if (
            provider.container === 'raw-pcm'
            && pcm.length >= WAV_HEADER_BYTES
            && pcm.subarray(0, WAV_MAGIC.length).equals(WAV_MAGIC)
          ) {
            pcm = pcm.subarray(WAV_HEADER_BYTES);
          }
        }
        forwardedBytes += pcm.length;
        unflushedBytes += pcm.length;
        session.send(pcm);

        // The DAILY cap, not the session's own length: the limit is a day's
        // allowance, so what matters is what the day has already used plus
        // what this session has streamed. Comparing the session alone let a
        // user at 590/600 stream another 600 seconds, and open another
        // session to repeat it.
        const sessionSeconds = forwardedBytes / (cfg.sampleRate * 2);
        if (quota.usedSecondsToday + sessionSeconds >= quota.limitSecondsToday) {
          terminate(AsrApiCode.DailyLimitExceeded, 'daily quota exhausted');
          return;
        }
        // The server enforces the session ceiling too. The desktop caps
        // recording at 60s client-side, but a client that does not would
        // otherwise stream until the daily quota tripped.
        if (Date.now() - startedAt >= MAX_SESSION_MS) {
          terminate(AsrApiCode.AudioTooLong, 'session length limit reached');
        }
      };

      // The client may have disconnected while the upstream was opening. The
      // upstream stream is now live and billed, so it has to be closed.
      if (socketClosed) {
        try {
          session.close();
        } catch {
          // Already closed.
        }
        return;
      }

      // Whatever arrived during the setup now flows, in order.
      const queued = pendingFrames.splice(0, pendingFrames.length);
      pendingBytes = 0;
      for (const frame of queued) {
        if (closed) break;
        handleFrame(frame.buf, frame.isBinary);
      }
    } catch (error) {
      // Nothing in here may escape: an unhandled rejection terminates the
      // process, and one member's voice input must not take down chat, media
      // and admin for every org.
      console.warn('[ASR] relay failed', error);
      release();
      try {
        stream?.close();
      } catch {
        // Already closed.
      }
      try {
        ws.close();
      } catch {
        // Socket already gone.
      }
    }
  }

  function releaseSession(userId: string): void {
    const next = (activeSessions.get(userId) ?? 1) - 1;
    if (next <= 0) activeSessions.delete(userId);
    else activeSessions.set(userId, next);
  }

  return { handleConnection };
}

function closeWithError(ws: WebSocket, code: number, message: string): void {
  try {
    ws.send(JSON.stringify({ type: 'error', code, message }));
  } catch {
    // The socket may already be gone; closing is still the right move.
  }
  try {
    ws.close();
  } catch {
    // Already closed.
  }
}

/** Resolve the provider row + decrypted key into what an adapter needs.
 *  Scoped by org as well as id: the id comes from a signed ticket so it is
 *  trustworthy today, but the org check is free defence in depth. */
async function resolveAsrConfigFromProviderKey(
  providerKeyId: string,
  orgId: string,
): Promise<ResolvedAsrConfig | null> {
  if (!providerKeyId) return null;
  const r = await pool.query<{
    id: string;
    provider: string;
    protocol: string;
    endpoint: string | null;
    config: Record<string, unknown> | null;
  }>(
    `SELECT id, provider, protocol, endpoint, config
       FROM provider_keys WHERE id = $1 AND org_id = $2 AND enabled`,
    [providerKeyId, orgId],
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
    sampleRate:
      typeof row.config?.sampleRate === 'number' ? row.config.sampleRate : 16000,
  };
}

async function defaultIsMemberActive(userId: string): Promise<boolean> {
  try {
    const r = await pool.query<{ status: string | null }>(
      `SELECT status FROM users WHERE id = $1`,
      [userId],
    );
    const status = r.rows[0]?.status;
    return status === null ? false : status === 'active';
  } catch {
    // Fail open, like `requireActiveMember`: a transient DB problem must not
    // look like a revocation.
    return true;
  }
}
