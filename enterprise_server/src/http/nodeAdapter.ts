import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { shouldStreamResponse } from './responseStreaming';

interface FetchableApp {
  fetch(req: Request): Response | Promise<Response>;
}

/**
 * Adapt a Hono app to a `node:http` request listener.
 *
 * Extracted from `serve()` so the streaming decision is testable: a route
 * test through `app.request()` never reaches this code, and a buffered SSE
 * response is invisible until a real client hangs on it.
 */
export function createNodeRequestHandler(
  app: FetchableApp,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) headers.set(k, v.join(','));
      else if (typeof v === 'string') headers.set(k, v);
    }
    let body: Uint8Array | undefined;
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = new Uint8Array(Buffer.concat(chunks));
    }
    const method = req.method ?? 'GET';
    const honoRes = await app.fetch(new Request(url, { method, headers, body }));
    res.statusCode = honoRes.status;
    honoRes.headers.forEach((v, k) => res.setHeader(k, v));
    // Stream what must not be buffered: release installer downloads
    // (`accept-ranges`) and MCP's server→client SSE channel, which stays open
    // for the life of a session — buffering it would mean never answering.
    if (shouldStreamResponse(honoRes.headers) && honoRes.body) {
      const readable = Readable.fromWeb(honoRes.body as ReadableStream<Uint8Array>);
      readable.on('error', (err) => {
        // A client that hung up mid-stream aborts its own body read, which
        // surfaces here as a stream error. Every desktop closing an MCP
        // session does exactly this, so it is normal, not a server fault —
        // logging it at error level would fill the log with stack traces for
        // a working product.
        if (res.destroyed || res.writableEnded) {
          console.debug('[NodeAdapter] stream closed by client');
          return;
        }
        console.error('[NodeAdapter] stream error', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'download_failed' }));
        } else {
          res.end();
        }
      });
      readable.pipe(res);
      return;
    }
    const buf = Buffer.from(await honoRes.arrayBuffer());
    res.end(buf);
  };
}
