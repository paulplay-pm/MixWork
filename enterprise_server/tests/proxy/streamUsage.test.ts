import { describe, expect, test } from 'vitest';

import { type UpstreamUsage,withUsageTap } from '../../src/proxy/streamUsage';

/** An SSE response delivered in the exact chunk boundaries given. The chunks
 *  are handed over verbatim (no `type: 'bytes'` re-chunking) so the
 *  pass-through comparison in the byte-identity test is meaningful. */
function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

function decode(rs: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(rs).text();
}

describe('proxy/streamUsage withUsageTap', () => {
  test('usage is parsed from the final SSE chunk', async () => {
    let got: UpstreamUsage | undefined;
    const src = sseStream(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":34}}\n\n',
      'data: [DONE]\n\n',
    );
    await decode(withUsageTap(src, (u) => { got = u; }));
    expect(got).toEqual({ tokenIn: 120, tokenOut: 34 });
  });

  // Review Focus #5: chunk boundaries are arbitrary, so the JSON object that
  // carries the usage routinely straddles two reads. A per-chunk JSON.parse
  // sees neither half and the tokens are lost.
  test('a usage object split across two chunk boundaries is still parsed', async () => {
    let got: UpstreamUsage | undefined;
    const src = sseStream(
      'data: {"choices":[],"usage":{"prompt_to',
      'kens":7,"completion_tokens":9}}\n\ndata: [DONE]\n\n',
    );
    await decode(withUsageTap(src, (u) => { got = u; }));
    expect(got).toEqual({ tokenIn: 7, tokenOut: 9 });
  });

  test('pass-through bytes are byte-for-byte identical to the source', async () => {
    const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'];
    const original = await decode(sseStream(...chunks));
    const tapped = await decode(withUsageTap(sseStream(...chunks), () => {}));
    expect(tapped).toBe(original);
  });

  test('a stream with no usage chunk leaves the callback un-fired', async () => {
    let calls = 0;
    const src = sseStream(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: [DONE]\n\n',
    );
    await decode(withUsageTap(src, () => { calls += 1; }));
    expect(calls).toBe(0);
  });

  // `data: [DONE]` is not JSON, and a provider may emit comment/keep-alive
  // lines. A parse failure must be swallowed: it must not tear down the
  // client-facing stream.
  test('malformed data lines do not throw', async () => {
    let got: UpstreamUsage | undefined;
    const src = sseStream(
      ': keep-alive\n\n',
      'data: [DONE]\n\n',
      'data: {not json at all\n\n',
      'data: {"usage":"nope"}\n\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    );
    await expect(decode(withUsageTap(src, (u) => { got = u; }))).resolves.toContain('[DONE]');
    expect(got).toEqual({ tokenIn: 3, tokenOut: 4 });
  });

  // The usage event is not necessarily the last one before [DONE], and a
  // provider may keep emitting afterwards — the tap must stop at the first
  // usage it sees rather than letting a later chunk overwrite it.
  test('only the first usage event is reported', async () => {
    const seen: UpstreamUsage[] = [];
    const src = sseStream(
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
      'data: {"usage":{"prompt_tokens":99,"completion_tokens":99}}\n\n',
      'data: [DONE]\n\n',
    );
    await decode(withUsageTap(src, (u) => { seen.push(u); }));
    expect(seen).toEqual([{ tokenIn: 1, tokenOut: 2 }]);
  });

  // A stream that ends without a trailing blank line still carries its usage:
  // the flush has to scan the trailing partial event.
  test('usage in a final event with no trailing blank line is found', async () => {
    let got: UpstreamUsage | undefined;
    const src = sseStream('data: {"usage":{"prompt_tokens":11,"completion_tokens":12}}\n');
    await decode(withUsageTap(src, (u) => { got = u; }));
    expect(got).toEqual({ tokenIn: 11, tokenOut: 12 });
  });

  // CRLF line endings are legal SSE and some gateways emit them.
  test('CRLF framed streams are parsed', async () => {
    let got: UpstreamUsage | undefined;
    const src = sseStream(
      'data: {"choices":[]}\r\n\r\n',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":6}}\r\n\r\n',
    );
    await decode(withUsageTap(src, (u) => { got = u; }));
    expect(got).toEqual({ tokenIn: 5, tokenOut: 6 });
  });
});
