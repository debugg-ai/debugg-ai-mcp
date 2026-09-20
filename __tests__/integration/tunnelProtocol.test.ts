/**
 * Debugg tunnel wire protocol over a REAL websocket (bead debugg_ai_mcp-xkoh.1.4, 2.2).
 *
 * The unit tests in __tests__/services/tunnel/protocol/ drive the session frame by
 * frame through a fake transport. This file is the other half: two sessions, one
 * `ws` loopback server, and the paths that only break when real sockets, real
 * backpressure and a real upgrade handshake are involved.
 *
 * Self-contained — no network, no backend, no binaries — so unlike
 * __tests__/integration/caddyProxy.test.ts it never needs to skip. It is picked
 * up by both `npm test` and `npm run test:integration`, so every server and
 * socket here is closed in afterEach: the integration config has no forceExit.
 */

import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

import { TunnelSession } from '../../services/tunnel/protocol/session.js';
import type { TunnelStream } from '../../services/tunnel/protocol/stream.js';
import type { ProbeResult } from '../../services/tunnel/protocol/codec.js';
import { webSocketTransport } from '../../services/tunnel/protocol/transport.js';
import {
  buildHandshakeHeaders,
  validateHandshakeRequest,
} from '../../services/tunnel/protocol/handshake.js';
import {
  CloseCode,
  INITIAL_WINDOW,
  MAX_FRAME_SIZE,
  PROTOCOL_VERSION,
} from '../../services/tunnel/protocol/constants.js';

const TUNNEL_ID = 'abc123';
const TUNNEL_KEY = 'tk_test_key';
const TEST_TIMEOUT = 30_000;

interface Harness {
  url: string;
  serverSession: () => TunnelSession;
  /**
   * Whatever the server side threw while handling an upgrade. Without this a
   * throw inside the upgrade handler just leaves the client socket hanging until
   * the test times out, and the real error never reaches the report.
   */
  failure: () => Error | undefined;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    try {
      await cleanup?.();
    } catch {
      /* teardown is best effort */
    }
  }
});

/** A loopback tunnel server: the upgrade handling a real tunnel server would do. */
async function startTunnelServer(options: { onProbe?: (req: { path: string }) => Promise<ProbeResult> } = {}): Promise<Harness> {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_SIZE });
  const server = http.createServer();
  let session: TunnelSession | undefined;
  let failure: Error | undefined;
  const sockets = new Set<WebSocket>();

  server.on('upgrade', (req, socket, head) => {
    try {
      const result = validateHandshakeRequest(req.headers as Record<string, string | string[] | undefined>);
      if (!result.ok) {
        const body = JSON.stringify(result.body);
        const headers = Object.entries(result.responseHeaders)
          .map(([name, value]) => `${name}: ${value}\r\n`)
          .join('');
        socket.end(
          `HTTP/1.1 ${result.status} ${result.status === 426 ? 'Upgrade Required' : 'Error'}\r\n` +
            headers +
            `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
            body,
        );
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        try {
          session = new TunnelSession(webSocketTransport(ws), { role: 'server', onProbe: options.onProbe });
        } catch (err) {
          failure = err as Error;
          ws.terminate();
        }
      });
    } catch (err) {
      failure = err as Error;
      socket.destroy();
    }
  });

  // The 101 carries the negotiated version back to the client.
  wss.on('headers', (headers, req) => {
    const result = validateHandshakeRequest(req.headers as Record<string, string | string[] | undefined>);
    if (result.ok) {
      for (const [name, value] of Object.entries(result.responseHeaders)) headers.push(`${name}: ${value}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const harness: Harness = {
    url: `ws://127.0.0.1:${port}/tunnel/v1/connect`,
    serverSession: () => {
      if (failure) throw failure;
      if (!session) throw new Error('no tunnel client has connected yet');
      return session;
    },
    failure: () => failure,
    close: async () => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  cleanups.push(harness.close);
  return harness;
}

function openClientSocket(url: string, headers: Record<string, string>): WebSocket {
  const ws = new WebSocket(url, { headers, perMessageDeflate: false, maxPayload: MAX_FRAME_SIZE });
  cleanups.push(() => ws.terminate());
  return ws;
}

/**
 * Wait for one websocket event, but give up the moment the socket fails — and
 * report the server's own error when there is one, so a stubbed module shows up
 * as "not implemented" instead of a 30 second timeout.
 */
function socketEvent(ws: WebSocket, event: string, harness: Harness): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    ws.once(event, (...args: unknown[]) => resolve(args));
    ws.once('error', (err: Error) => reject(harness.failure() ?? err));
    ws.once('close', () => reject(harness.failure() ?? new Error(`socket closed before ${event}`)));
  });
}

/** Connect a client session and wait until the server side exists too. */
async function connect(harness: Harness): Promise<{ client: TunnelSession; server: TunnelSession; ws: WebSocket }> {
  const ws = openClientSocket(harness.url, buildHandshakeHeaders({ tunnelId: TUNNEL_ID, tunnelKey: TUNNEL_KEY }));
  await socketEvent(ws, 'open', harness);
  const client = new TunnelSession(webSocketTransport(ws), { role: 'client' });
  await waitFor(
    () => {
      if (harness.failure()) throw harness.failure();
      return session(harness) !== undefined;
    },
    'server session',
  );
  return { client, server: harness.serverSession(), ws };
}

function session(harness: Harness): TunnelSession | undefined {
  try {
    return harness.serverSession();
  } catch (err) {
    if (harness.failure()) throw err;
    return undefined;
  }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Deterministic bytes, so a byte-exactness failure is reproducible. */
function seededBytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

function collect(stream: TunnelStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

describe('tunnel protocol over a real websocket — the handshake', () => {
  it(
    'completes and echoes the negotiated version',
    async () => {
      const harness = await startTunnelServer();
      const ws = openClientSocket(harness.url, buildHandshakeHeaders({ tunnelId: TUNNEL_ID, tunnelKey: TUNNEL_KEY }));

      const [response] = (await socketEvent(ws, 'upgrade', harness)) as [http.IncomingMessage];

      expect(response.statusCode).toBe(101);
      expect(response.headers['x-debugg-tunnel-protocol']).toBe(String(PROTOCOL_VERSION));
    },
    TEST_TIMEOUT,
  );

  it(
    'refuses an unsupported version with 426 and says what it speaks',
    async () => {
      const harness = await startTunnelServer();
      const ws = openClientSocket(harness.url, {
        Authorization: `Bearer ${TUNNEL_KEY}`,
        'X-Debugg-Tunnel-Id': TUNNEL_ID,
        'X-Debugg-Tunnel-Protocol': '99',
      });

      ws.once('open', () => ws.close());
      const [, response] = (await socketEvent(ws, 'unexpected-response', harness)) as [
        http.ClientRequest,
        http.IncomingMessage,
      ];

      expect(response.statusCode).toBe(426);
      expect(response.headers['x-debugg-tunnel-supported']).toBe('1');
    },
    TEST_TIMEOUT,
  );
});

describe('tunnel protocol over a real websocket — multiplexing', () => {
  it(
    'carries 200 concurrent streams of assorted sizes, byte exact in both directions',
    async () => {
      const harness = await startTunnelServer();
      const { client, server } = await connect(harness);

      // The client end behaves like the MCP does: pipe the stream straight back
      // at its local target. Here the "local target" is an echo.
      client.on('stream', (stream: TunnelStream) => {
        stream.pipe(stream);
      });

      const count = 200;
      const results = await Promise.all(
        Array.from({ length: count }, async (_unused, index) => {
          const size = index % 20 === 0 ? 1024 * 1024 : 1 + ((index * 7919) % (32 * 1024));
          const payload = seededBytes(size, index + 1);
          const stream = server.openStream({ kind: 'http', requestId: `r-${index}` });
          const echoed = collect(stream);
          stream.end(payload);
          return { index, size, ok: sha256(await echoed) === sha256(payload) };
        }),
      );

      expect(results.filter((r) => !r.ok)).toEqual([]);
      expect(results).toHaveLength(count);
      await waitFor(() => server.activeStreamCount === 0 && client.activeStreamCount === 0, 'streams freed');
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps memory bounded when the consumer is slower than the producer',
    async () => {
      const harness = await startTunnelServer();
      const { client, server } = await connect(harness);

      const total = 8 * 1024 * 1024;
      let produced = 0;
      let consumed = 0;
      let worstGap = 0;

      const source = new Readable({
        read() {
          if (produced >= total) {
            this.push(null);
            return;
          }
          const size = Math.min(64 * 1024, total - produced);
          produced += size;
          this.push(Buffer.alloc(size, 0x7a));
        },
      });

      const received = new Promise<void>((resolve, reject) => {
        client.on('stream', (stream: TunnelStream) => {
          stream.pause();
          const pump = setInterval(() => {
            const chunk = stream.read(64 * 1024) as Buffer | null;
            if (chunk) {
              consumed += chunk.length;
              worstGap = Math.max(worstGap, produced - consumed);
            }
          }, 5);
          stream.once('end', () => {
            clearInterval(pump);
            let tail = stream.read() as Buffer | null;
            while (tail) {
              consumed += tail.length;
              tail = stream.read() as Buffer | null;
            }
            resolve();
          });
          stream.once('error', (err: Error) => {
            clearInterval(pump);
            reject(err);
          });
        });
      });

      const stream = server.openStream({ kind: 'http' });
      source.pipe(stream);
      await received;

      expect(consumed).toBe(total);
      // Whatever is in flight is one window plus node's own buffers on each hop —
      // never a function of how much the producer has to send.
      expect(worstGap).toBeLessThan(INITIAL_WINDOW + 2 * 1024 * 1024);
    },
    TEST_TIMEOUT,
  );
});

describe('tunnel protocol over a real websocket — losing and shutting down the socket', () => {
  it(
    'errors every open stream on both sides when the socket dies, and hangs nothing',
    async () => {
      const harness = await startTunnelServer();
      const { client, server, ws } = await connect(harness);

      const clientStreams: TunnelStream[] = [];
      const clientErrors: Error[] = [];
      client.on('stream', (stream: TunnelStream) => {
        clientStreams.push(stream);
        stream.on('error', (err: Error) => clientErrors.push(err));
        stream.resume();
      });

      const serverStreams = Array.from({ length: 20 }, () => server.openStream({ kind: 'http' }));
      const serverErrors: Error[] = [];
      for (const stream of serverStreams) {
        stream.on('error', (err: Error) => serverErrors.push(err));
        stream.write(seededBytes(4096, 3));
      }
      await waitFor(() => clientStreams.length === 20, 'streams surfaced');

      ws.terminate();

      await waitFor(() => serverErrors.length === 20, 'server streams failed');
      await waitFor(() => clientErrors.length === 20, 'client streams failed');
      await waitFor(() => server.closed && client.closed, 'both sessions closed');
      expect(server.activeStreamCount).toBe(0);
      expect(client.activeStreamCount).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'drains in-flight streams after GOAWAY, then closes cleanly',
    async () => {
      const harness = await startTunnelServer();
      const { client, server } = await connect(harness);

      const inbound = new Promise<TunnelStream>((resolve) => client.once('stream', resolve));
      const stream = server.openStream({ kind: 'http' });
      const clientStream = await inbound;

      const goaway = new Promise<{ code: number }>((resolve) => client.once('goaway', resolve));
      const closed = new Promise<{ closeCode: number }>((resolve) => server.once('close', resolve));
      const draining = server.goAway({ reason: 'deploy' });

      await goaway;
      // The stream that was already running still completes over the same socket.
      const echoed = collect(clientStream);
      stream.end(Buffer.from('response after goaway'));
      expect((await echoed).toString('utf8')).toBe('response after goaway');
      clientStream.end();

      await draining;
      expect((await closed).closeCode).toBe(CloseCode.NORMAL);
    },
    TEST_TIMEOUT,
  );

  it(
    'answers a control-channel PROBE over the real socket',
    async () => {
      const harness = await startTunnelServer({
        onProbe: async (request) => ({ status: request.path === '/health' ? 200 : 404, elapsedMs: 3 }),
      });
      const { client } = await connect(harness);

      await expect(client.probe('/health')).resolves.toEqual({ status: 200, elapsedMs: 3 });
    },
    TEST_TIMEOUT,
  );
});
