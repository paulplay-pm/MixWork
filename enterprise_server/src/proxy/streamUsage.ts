import { pool } from '../db/pool';

export interface UpstreamUsage {
  tokenIn: number;
  tokenOut: number;
}

/** SSE events are separated by a blank line; both LF and CRLF framings are
 *  legal on the wire and some gateways emit the latter. */
const EVENT_SEPARATOR = /\r?\n\r?\n/;

/** The offending field, named in whatever shape the provider uses. */
const FIELD_MENTION = /stream_options|include_usage/i;

/** Error codes meaning "I do not recognise this field", without naming it.
 *  Deliberately anchored on the parameter words so it cannot swallow
 *  `unknown_model` or `invalid_request_error`. */
const UNKNOWN_FIELD_CODE = /(unknown|unrecognized|unsupported)[._\s-]*(param|argument|field|request)/i;

/** Token counts as numbers, anything else (absent, null, string) as zero. */
function tokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Observe a streamed upstream response for its usage chunk while passing every
 * byte through to the client unchanged.
 *
 * The proxy hands `stream` straight to the client as the response body, so the
 * body cannot be buffered: buffering would delay the first token until the
 * completion finished, which is the one thing a streaming client cares about.
 * Instead the body is piped through a TransformStream whose `transform` does
 * two independent things — enqueue the chunk it received, untouched, and scan
 * a *copy* of it for usage. Because the chunk object handed to
 * `controller.enqueue` is the very one that came off the wire, the client
 * receives byte-identical framing: SSE separators, keep-alive comments and the
 * terminating `[DONE]` all survive. The tap cannot alter or reorder the stream
 * even in principle.
 *
 * TCP chunk boundaries are arbitrary, so a `usage` JSON object routinely
 * straddles two reads — parsing each chunk on its own would see neither half.
 * The scan therefore keeps a text buffer, splits it on the SSE event
 * separator, and only parses *complete* events; whatever follows the last
 * separator is retained until a later chunk (or the flush) completes it.
 *
 * Scanning stops at the first usage event seen: providers emit it once, and a
 * later chunk must not be able to overwrite the accounting with a stray
 * partial frame.
 *
 * `onEnd` fires when the body has been fully delivered *or* cancelled. The
 * caller uses it to flush accounting, and a client that disconnects mid-token
 * still has to leave a usage row behind — so the hook is wired through
 * `pipeTo`, whose promise settles on cancellation too, rather than
 * `pipeThrough`, whose `flush` does not run when the readable side is torn
 * down.
 */
export function withUsageTap(
  src: ReadableStream<Uint8Array>,
  onUsage: (u: UpstreamUsage) => void,
  onEnd?: () => void
): ReadableStream<Uint8Array> {
  let buffer = '';
  let found = false;
  const decoder = new TextDecoder();

  /** Returns true once a usage object has been reported. */
  function scanEvent(event: string): boolean {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      let parsed: unknown;
      try {
        // `[DONE]` and any provider-specific keep-alive payload land here.
        parsed = JSON.parse(line.slice(5).trimStart());
      } catch {
        continue;
      }
      const usage = (parsed as { usage?: unknown } | null)?.usage;
      if (!usage || typeof usage !== 'object') continue;
      const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
      onUsage({ tokenIn: tokenCount(u.prompt_tokens), tokenOut: tokenCount(u.completion_tokens) });
      return true;
    }
    return false;
  }

  /** Consumes every complete event in the buffer, keeping the trailing
   *  partial one for the next chunk. `final` flushes it instead. */
  function drain(final: boolean): void {
    const parts = buffer.split(EVENT_SEPARATOR);
    buffer = final ? '' : (parts.pop() ?? '');
    for (const event of parts) {
      if (scanEvent(event)) {
        found = true;
        buffer = '';
        return;
      }
    }
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Pass-through first, and unconditionally: whatever the scanner makes of
      // this chunk, the client gets exactly these bytes.
      controller.enqueue(chunk);
      if (found) return;
      try {
        // `stream: true` keeps a multi-byte character split across two chunks
        // from being mangled into U+FFFD by the decoder.
        buffer += decoder.decode(chunk, { stream: true });
        drain(false);
      } catch {
        // A scan failure must never break the client-facing stream.
      }
    },
    flush() {
      if (found) return;
      try {
        buffer += decoder.decode();
        drain(true);
      } catch {
        /* unparseable tail */
      }
    },
  });

  void src.pipeTo(writable).then(
    () => onEnd?.(),
    () => onEnd?.(),
  );
  return readable;
}

/**
 * Whether this OpenAI-compatible endpoint is known to accept
 * `stream_options.include_usage`.
 *
 * NULL (never probed) reads as supported: the field is only ever sent on a
 * streaming request, and the cost of guessing wrong in this direction is one
 * retry, whereas guessing wrong the other way forfeits the usage forever.
 */
export async function streamUsageSupported(providerKeyId: string): Promise<boolean> {
  const r = await pool.query<{ stream_usage_supported: boolean | null }>(
    `SELECT stream_usage_supported FROM provider_keys WHERE id=$1`,
    [providerKeyId],
  );
  return r.rows[0]?.stream_usage_supported !== false;
}

/**
 * Whether a rejection is evidence that this endpoint does not accept
 * `stream_options` — as opposed to evidence that the *request* was bad.
 *
 * Both halves matter, and the status half is not optional. OpenAI answers with
 * 400 for `context_length_exceeded` as well as for an unrecognized request
 * argument, so keying the downgrade on the status alone lets one over-long
 * prompt permanently disable usage accounting for that provider key. There is
 * no admin route, UI toggle, TTL or re-probe to undo that; the flag has exactly
 * one writer and one reader, and both are here. A false positive is unbounded
 * and survives every restart, while the false negative it avoids — probing one
 * more time — costs a single round-trip.
 *
 * So the status must be one a provider uses to reject the body shape, AND the
 * error itself has to point at the field.
 */
export function blamesStreamOptions(status: number, bodyText: string): boolean {
  // 401 is a bad credential and 429 is a throttle: both are about the caller,
  // and neither says anything about which fields the endpoint understands.
  if (status !== 400 && status !== 404 && status !== 422) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // A non-JSON body (an HTML error page, a proxy's plain-text 502) carries no
    // error shape to read, so it is not evidence either way.
    return false;
  }
  // OpenAI and friends nest under `error`; some gateways put it at the top level.
  const root = parsed as { error?: unknown } | null;
  const err = (root && typeof root === 'object' && root.error) || parsed;
  if (!err || typeof err !== 'object') return false;
  const e = err as { param?: unknown; code?: unknown; type?: unknown; message?: unknown };

  // The strongest signal: the provider names our field.
  if (typeof e.param === 'string' && FIELD_MENTION.test(e.param)) return true;
  if (typeof e.message === 'string' && FIELD_MENTION.test(e.message)) return true;
  // A gateway that rejects unknown fields without naming them. Scoped to
  // unknown/unrecognized/unsupported *parameter-ish* codes so that OpenAI's
  // generic `invalid_request_error` type — which also fronts
  // `context_length_exceeded` — cannot trigger it.
  if (typeof e.code === 'string' && UNKNOWN_FIELD_CODE.test(e.code)) return true;
  if (typeof e.type === 'string' && UNKNOWN_FIELD_CODE.test(e.type)) return true;
  return false;
}

/**
 * Remember that this endpoint rejected `stream_options`, so later requests stop
 * paying a failed round-trip to find out again. Call this only with evidence
 * from `blamesStreamOptions` — see there for why a guess here is permanent.
 * Persisted rather than cached in memory: a process-local cache is lost on
 * every restart, which would make each deployment pay the tax forever.
 */
export async function markStreamUsageUnsupported(providerKeyId: string): Promise<void> {
  await pool.query(
    `UPDATE provider_keys SET stream_usage_supported=false
       WHERE id=$1 AND stream_usage_supported IS NULL`,
    [providerKeyId],
  );
}

/**
 * The outgoing body for a streaming request. When the endpoint is known to
 * accept `stream_options` the usage flag is added (merged into whatever the
 * client already set, so a provider-specific sibling option is not clobbered);
 * when it is known to reject the field the body goes out untouched.
 */
export function buildStreamBody(
  body: Record<string, unknown>,
  supported: boolean,
): Record<string, unknown> {
  if (!supported) return body;
  const existing = body.stream_options;
  const merged =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>), include_usage: true }
      : { include_usage: true };
  return { ...body, stream_options: merged };
}
