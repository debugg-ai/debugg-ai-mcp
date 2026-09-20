/**
 * An in-process debugg tunnel SERVER, built on the shared wire-protocol module
 * (services/tunnel/protocol/). Test helper for beads debugg_ai_mcp-xkoh.5.4 and
 * xkoh.5.8. Not a test file — jest collects *.test.ts only.
 *
 * It drives the REAL TunnelSession in its 'server' role rather than hand-rolling
 * frames. That is deliberate and was learned the hard way on the server arc: a
 * hand-rolled test client that ignored WINDOW truncated a 2 MiB download at
 * ~1.5 MB, so the harness, not the code, was wrong. Anything this helper
 * implements by hand is a place where a real bug can hide behind a green test —
 * so it implements nothing by hand except the parts that are genuinely the
 * server's own policy (ingress, and the error pages).
 *
 * Shape mirrors the design (docs/debugg-tunnel-server-design-2026-09-19.md §3):
 *   - a control websocket (nginx location /tunnel/ in production);
 *   - a raw-TCP ingress (nginx's tunnel server block), where one browser
 *     connection becomes one stream, piped as bytes;
 *   - PROBE answered by issuing a real GET back through that same ingress, so
 *     a probe is indistinguishable from browser traffic on the client side.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as WsNamespace from 'ws';

import {
  TunnelSession,
  webSocketTransport,
  ErrorCode,
  MAX_FRAME_SIZE,
  MARKER_HTTP_STATUS,
  TunnelErrorMarker,
  StreamResetError,
  type ProbeResult,
  type TunnelStream,
} from '../../services/tunnel/protocol/index.js';

// `ws` is CommonJS: depending on the loader, the namespace, its default export
// or the named export is the live object. Take whichever one is real.
const ws: any = WsNamespace as any;
const WebSocketServer: any = ws.WebSocketServer ?? ws.default?.WebSocketServer ?? ws.Server ?? ws.default?.Server;

export class FakeTunnelServerForTests {
  private wss: any;
  private controlHttp!: http.Server;
  private ingress!: net.Server;
  private session: TunnelSession | undefined;
  /** Every session this server has accepted: a reconnect leaves one draining. */
  private readonly sessions = new Set<TunnelSession>();
  private readonly sockets = new Set<any>();

  controlPort = 0;
  ingressPort = 0;

  /** Handshake headers, one entry per upgrade attempt. */
  readonly handshakes: Array<Record<string, unknown>> = [];

  /** Lets a test force a rejection: return 401 / 426 instead of 101. */
  authorize: (headers: Record<string, unknown>) => number = () => 101;

  constructor(private readonly host: string) {}

  async start(): Promise<void> {
    this.controlHttp = http.createServer();
    this.wss = new WebSocketServer({
      server: this.controlHttp,
      path: '/tunnel/v1/connect',
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_SIZE,
      verifyClient: (info: any, cb: any) => {
        this.handshakes.push({ ...info.req.headers });
        const status = this.authorize(info.req.headers);
        if (status === 101) cb(true);
        else cb(false, status, JSON.stringify({ error: 'UNAUTHORIZED' }));
      },
    });
    this.wss.on('headers', (headers: string[]) => {
      headers.push('X-Debugg-Tunnel-Protocol: 1');
    });
    this.wss.on('connection', (socket: any) => {
      this.sockets.add(socket);
      const session = new TunnelSession(webSocketTransport(socket), {
        role: 'server',
        onProbe: (request) => this.answerProbe(request.path),
      });
      this.sessions.add(session);
      this.session = session;
      session.on('error', () => { /* diagnostics only */ });
      session.on('close', () => {
        this.sessions.delete(session);
        this.sockets.delete(socket);
        if (this.session === session) this.session = undefined;
      });
    });

    this.ingress = net.createServer((sock) => this.onBrowserConnection(sock));

    await new Promise<void>((r) => this.controlHttp.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => this.ingress.listen(0, '127.0.0.1', r));
    this.controlPort = (this.controlHttp.address() as AddressInfo).port;
    this.ingressPort = (this.ingress.address() as AddressInfo).port;
  }

  get relayUrl(): string {
    return `ws://127.0.0.1:${this.controlPort}/tunnel/v1/connect`;
  }

  get connected(): boolean {
    return !!this.session && !this.session.closed;
  }

  /** The SIGTERM path: tell the client to reconnect. */
  goaway(code: number = ErrorCode.GOING_AWAY): void {
    void this.session?.goAway({ code, reason: 'deploy' }).catch(() => { /* draining */ });
  }

  dropConnection(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  async stop(): Promise<void> {
    for (const session of this.sessions) {
      try { session.close(ErrorCode.GOING_AWAY, 'test teardown'); } catch { /* already closed */ }
    }
    this.sessions.clear();
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.session = undefined;
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.controlHttp.close(() => r()));
    await new Promise<void>((r) => this.ingress.close(() => r()));
  }

  /**
   * One browser connection becomes one stream, piped as raw bytes — the server
   * reads nothing but the head in production, and here not even that.
   */
  private onBrowserConnection(sock: net.Socket): void {
    const session = this.session;
    if (!session || session.closed) {
      sock.end(this.markerResponse(TunnelErrorMarker.OFFLINE));
      return;
    }

    let stream: TunnelStream;
    try {
      stream = session.openStream({ kind: 'http' });
    } catch {
      sock.end(this.markerResponse(TunnelErrorMarker.OFFLINE));
      return;
    }

    // pipe() in both directions: the stream's own backpressure is what applies
    // flow control, which is the entire reason this helper does not move bytes
    // by hand.
    sock.pipe(stream);
    stream.pipe(sock);

    stream.on('error', (err: Error) => {
      const code = err instanceof StreamResetError ? err.code : ErrorCode.RESET;
      if (code === ErrorCode.UPSTREAM_UNREACHABLE) {
        // The client could not dial the local app: render the marker page a
        // browser would see, which is what probeTunnelHealth then classifies.
        sock.end(this.markerResponse(TunnelErrorMarker.UPSTREAM_REFUSED));
        return;
      }
      sock.destroy();
    });
    sock.on('error', () => { stream.destroy(); });
  }

  /**
   * A real GET back through our own ingress, exactly as the design specifies:
   * the probe takes the full public path and is browser-shaped to the client.
   */
  private answerProbe(path: string): Promise<ProbeResult> {
    const started = Date.now();
    return new Promise<ProbeResult>((resolve) => {
      const sock = net.connect(this.ingressPort, '127.0.0.1', () => {
        sock.write(`GET ${path} HTTP/1.1\r\nHost: ${this.host}\r\nConnection: close\r\n\r\n`);
      });
      let raw = '';
      sock.setTimeout(4000, () => {
        sock.destroy();
        resolve({ error: 'TIMEOUT', elapsedMs: Date.now() - started });
      });
      sock.on('data', (d) => { raw += d.toString('utf8'); });
      sock.on('error', () => resolve({ error: 'RESET', elapsedMs: Date.now() - started }));
      sock.on('close', () => {
        const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(raw)?.[1]);
        if (!status) return resolve({ error: 'RESET', elapsedMs: Date.now() - started });
        const marker = Object.values(TunnelErrorMarker).find((m) => raw.includes(m));
        resolve({ status, ...(marker ? { marker } : {}), elapsedMs: Date.now() - started });
      });
    });
  }

  private markerResponse(marker: string): string {
    const status = (MARKER_HTTP_STATUS as Record<string, number>)[marker] ?? 502;
    const body = `<html><body><code>${marker}</code></body></html>`;
    return [
      `HTTP/1.1 ${status} Tunnel Error`,
      'Content-Type: text/html',
      `X-Debugg-Tunnel-Error: ${marker}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n');
  }
}
