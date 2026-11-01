import {
  blamesStreamOptions,
  buildStreamBody,
  markStreamUsageUnsupported,
  streamUsageSupported,
  type UpstreamUsage,
  withUsageTap,
} from './streamUsage';

export interface UpstreamRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
  /** Provider key id. Keys the per-endpoint memory of whether this
   *  OpenAI-compatible endpoint accepts `stream_options.include_usage`; the
   *  downgrade is recorded against it so later requests skip the probe. */
  providerKeyId: string;
}

export interface UpstreamResponse {
  status: number;
  bodyText: string;
  /** Usage read synchronously from a non-streaming body. Always null for a
   *  streaming call — its usage only exists once the body has been consumed,
   *  which is what `settled` is for. */
  usage: UpstreamUsage | null;
  stream?: ReadableStream;
  /** Settles with the usage for this call, or null when the provider sent none.
   *  Already resolved for a non-streaming response; for a streaming one it
   *  settles when the client has drained (or abandoned) the body. */
  settled: Promise<UpstreamUsage | null>;
}

/** Read a response body we are about to throw away. An unreadable body is
 *  reported as empty, which `blamesStreamOptions` treats as no evidence. */
async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function isStream(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { stream?: unknown }).stream === true;
}

export async function callOpenAI(req: UpstreamRequest): Promise<UpstreamResponse> {
  if (!isStream(req.body)) {
    const res = await fetch(req.endpoint, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
    });
    const bodyText = await res.text();
    let usage: UpstreamUsage | null = null;
    try {
      const j = JSON.parse(bodyText) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (j.usage) {
        usage = {
          tokenIn: j.usage.prompt_tokens ?? 0,
          tokenOut: j.usage.completion_tokens ?? 0,
        };
      }
    } catch {
      /* non-json */
    }
    return { status: res.status, bodyText, usage, settled: Promise.resolve(usage) };
  }

  // ---- Streaming. The body cannot be read here (the client needs it live), so
  // the usage is tapped out of the stream on its way past rather than awaited.
  const send = (body: unknown): Promise<Response> =>
    fetch(req.endpoint, { method: 'POST', headers: req.headers, body: JSON.stringify(body) });

  const base = req.body as Record<string, unknown>;
  const supported = await streamUsageSupported(req.providerKeyId);
  let res = await send(buildStreamBody(base, supported));

  if (supported && res.status >= 400 && res.status < 500) {
    // Always retry without the field: whatever went wrong, the call is more
    // likely to succeed on the second try, and one round-trip is cheap.
    //
    // But only *remember* it when the rejection actually implicates
    // `stream_options`. The retry is unconditional; the downgrade is not — see
    // `blamesStreamOptions` for why a wrong guess here cannot be undone.
    const blamed = blamesStreamOptions(res.status, await readBodyText(res));
    if (blamed) await markStreamUsageUnsupported(req.providerKeyId);
    res = await send(buildStreamBody(base, false));
  }

  let settle: (u: UpstreamUsage | null) => void = () => {};
  const settled = new Promise<UpstreamUsage | null>((resolve) => {
    settle = resolve;
  });
  let tapped: UpstreamUsage | null = null;
  const source = res.body;
  const stream = source
    ? withUsageTap(
        source,
        (u) => {
          tapped = u;
        },
        () => settle(tapped)
      )
    : undefined;
  // A bodiless streaming response (204/304) has nothing to tap, and there is no
  // tap to report completion — settle now rather than leave `settled` pending
  // forever on a promise nobody is waiting on yet.
  if (!source) settle(null);

  return { status: res.status, bodyText: '', usage: null, stream, settled };
}
