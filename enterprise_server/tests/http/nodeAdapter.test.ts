import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';

import { afterEach, expect, test, vi } from 'vitest';

import { createNodeRequestHandler } from '../../src/http/nodeAdapter';

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

test('an sse chunk reaches the client while the stream is still open', async () => {
  let push!: (s: string) => void;
  const body = new ReadableStream({
    start(c) {
      push = (s) => c.enqueue(new TextEncoder().encode(s));
    },
  });
  const app = {
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  };
  const server = http.createServer(createNodeRequestHandler(app));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  close = () => server.close();
  const port = (server.address() as { port: number }).port;

  const received = await new Promise<string>((resolve, reject) => {
    const sentinel = setTimeout(
      () => reject(new Error('adapter buffered: no chunk arrived while the stream was open')),
      2000,
    );
    http.get({ port, host: '127.0.0.1' }, (res) => {
      res.once('data', (buf) => {
        clearTimeout(sentinel);
        resolve(buf.toString());
      });
    });
    push('data: hello\n\n');
  });

  expect(received).toContain('data: hello');
});

/** A stand-in for `ServerResponse`: a real `Writable` (so `pipe` works) with
 *  the fields the adapter reads. */
function fakeResponse(overrides: { destroyed: boolean; headersSent: boolean }): Writable & {
  statusCode: number;
  setHeader(name: string, value: string): void;
  chunks: string[];
} {
  const res = new Writable({
    write(chunk, _enc, cb) {
      (res as unknown as { chunks: string[] }).chunks.push(String(chunk));
      cb();
    },
  }) as Writable & { statusCode: number; setHeader(n: string, v: string): void; chunks: string[] };
  res.chunks = [];
  res.statusCode = 200;
  res.destroyed = overrides.destroyed;
  (res as unknown as { headersSent: boolean }).headersSent = overrides.headersSent;
  res.setHeader = () => {};
  return res;
}

function fakeRequest(): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(req, { method: 'GET', url: '/mcp', headers: { host: '127.0.0.1' } });
  return req;
}

/** Let the body's async error surface through `Readable.fromWeb`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

const erroringStream = (message: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.error(new Error(message));
    },
  });

test('a stream error after the client hung up is not logged as a server fault', async () => {
  const app = {
    fetch: async () =>
      new Response(erroringStream('terminated'), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  };
  const res = fakeResponse({ destroyed: true, headersSent: true });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  try {
    await createNodeRequestHandler(app)(
      fakeRequest(),
      res as unknown as ServerResponse,
    );
    await settle();
    expect(debugSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  }
});

test('a stream error while the client is still connected is logged and answered', async () => {
  const app = {
    fetch: async () =>
      new Response(erroringStream('upstream died'), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  };
  const res = fakeResponse({ destroyed: false, headersSent: false });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await createNodeRequestHandler(app)(
      fakeRequest(),
      res as unknown as ServerResponse,
    );
    await settle();
    expect(errorSpy).toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.chunks.join('')).toContain('download_failed');
  } finally {
    errorSpy.mockRestore();
  }
});
