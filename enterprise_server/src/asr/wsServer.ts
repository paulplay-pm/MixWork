import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import { type WebSocket,WebSocketServer } from 'ws';

export const ASR_WS_PATH = '/api/asr/realtime';

export interface AsrWsServer {
  port: number;
  httpServer: Server;
  wss: WebSocketServer;
  handleUpgrade: (request: IncomingMessage, socket: Socket, head: Buffer) => void;
  close: () => Promise<void>;
}

export type AsrConnectionHandler = (
  socket: WebSocket,
  request: IncomingMessage,
) => void | Promise<void>;

/**
 * The websocket upgrade for the ASR relay.
 *
 * `node:http` has no notion of a websocket: an upgrade request reaching the
 * app's ordinary request handler would be answered as an HTTP request and log
 * a confusing error. So the upgrade is intercepted before Hono sees it, and
 * only `/api/asr/realtime` is upgraded — every other path is destroyed, which
 * is what a client hitting a non-websocket path expects.
 *
 * The server can either own its own listener (tests) or hand `handleUpgrade`
 * to the app's listener (production), so there is ONE upgrade policy rather
 * than two that can disagree.
 */
export function createAsrWebSocketServer(onConnection?: AsrConnectionHandler): AsrWsServer {
  const httpServer = createServer((_req, res) => {
    res.statusCode = 426;
    res.end('upgrade required');
  });
  const wss = new WebSocketServer({ noServer: true });

  const handleUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const path = (request.url ?? '').split('?')[0];
    if (path !== ASR_WS_PATH) {
      socket.destroy();
      return;
    }
    // The callback IS the connection hook. `ws`'s handleUpgrade does NOT emit
    // 'connection' — that only happens for a server constructed with
    // `{ server }`. Listening for the event instead silently does nothing,
    // which leaves the socket upgraded and every frame ignored. So the
    // handler is invoked from the callback, and there is exactly one path.
    wss.handleUpgrade(request, socket, head, (ws) => {
      void onConnection?.(ws, request);
    });
  };
  httpServer.on('upgrade', handleUpgrade);

  return {
    port: 0,
    httpServer,
    wss,
    handleUpgrade,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Start the standalone server on an ephemeral port. Tests use this so they
 *  exercise the real upgrade path without booting the whole Hono app. */
export async function startAsrWebSocketServer(
  onConnection?: AsrConnectionHandler,
): Promise<AsrWsServer> {
  const server = createAsrWebSocketServer(onConnection);
  await new Promise<void>((resolve) => server.httpServer.listen(0, () => resolve()));
  const address = server.httpServer.address();
  server.port = typeof address === 'object' && address ? address.port : 0;
  return server;
}
