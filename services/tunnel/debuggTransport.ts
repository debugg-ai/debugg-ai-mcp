/**
 * debuggTransport — the pure-TS tunnel client for the debugg tunnel server.
 *
 * One websocket per tunnel to the relayUrl a provision response supplies,
 * speaking the wire protocol in services/tunnel/protocol/ (spec: bead
 * debugg_ai_mcp-xkoh.1.2). It replaced the `ngrok` package, which downloaded and
 * spawns a native agent; `ws` is the only new dependency and is pure JS.
 *
 * This file owns exactly four things — the socket, the reconnect policy, the
 * DIAL policy, and publishing a prober for probeTunnelHealth. Framing, flow
 * control, liveness, GOAWAY drain and PROBE deadlines all belong to
 * TunnelSession, and are deliberately not reimplemented here.
 *
 * THE DIAL POLICY IS THE SECURITY BOUNDARY: a stream is always piped to the
 * address TunnelManager registered at connect() and never to anything the
 * server sends. The protocol's decoder already strips address-shaped fields
 * from OPEN metadata; this is the second half of that guarantee.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import WebSocket from 'ws';

import { Logger } from '../../utils/logger.js';
import {
  buildHandshakeHeaders,
  interpretHandshakeResponse,
  webSocketTransport,
  CloseCode,
  ErrorCode,
  MAX_FRAME_SIZE,
  PROBE_TIMEOUT_MS,
  TunnelSession,
  type ProbeResult,
  type TunnelStream,
  type WebSocketLike,
} from './protocol/index.js';
import { registerControlProbe, unregisterControlProbe } from './probeRegistry.js';
import type { TunnelConnectOptions, TunnelTransport, TunnelTransportError } from './transport.js';

const logger = new Logger({ module: 'debuggTransport' });

/**
 * The handshake response the client inspects: the 101 upgrade (to check the
 * server's echoed protocol version) and the 400/401/426 rejections. Shaped as
 * the slice of node's IncomingMessage that ws hands over, so a test can pass a
 * plain object.
 */
export interface HandshakeResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The websocket this transport drives: `ws`'s client surface, structurally,
 * plus the three connection-lifecycle events the handshake needs. Structural so
 * the unit tests can drive a fake.
 *
 * The `on` overloads are spelled out rather than inherited from WebSocketLike:
 * TypeScript cannot widen an overload set through `extends`. A conformance
 * check below keeps the two in step.
 */
export interface DebuggSocketLike {
  send(data: Uint8Array, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'upgrade', listener: (res: HandshakeResponseLike) => void): unknown;
  on(event: 'unexpected-response', listener: (req: unknown, res: HandshakeResponseLike) => void): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** A DebuggSocketLike is always usable as the protocol module's WebSocketLike. */
const _socketIsWebSocketLike: (s: DebuggSocketLike) => WebSocketLike = (s) => s;
void _socketIsWebSocketLike;

/** Opens the control websocket. The default uses `ws`; tests inject a fake. */
export type DebuggSocketFactory = (
  url: string,
  init: { headers: Record<string, string> },
) => DebuggSocketLike;

export interface DebuggTransportOptions {
  /** Sent as X-Debugg-Tunnel-Client-Version, e.g. "debugg-ai-mcp/4.3.0". */
  clientVersion?: string;
  socketFactory?: DebuggSocketFactory;
  /** Backoff between reconnect attempts. The last entry is the cap. */
  reconnectBackoffMs?: number[];
  /** Per-PROBE deadline. Defaults to the protocol's PROBE_TIMEOUT_MS (5000). */
  probeTimeoutMs?: number;
  /** How long a handshake may hang before it counts as a failed attempt. */
  handshakeTimeoutMs?: number;
}

const DEFAULT_RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10000];

const defaultSocketFactory: DebuggSocketFactory = (url, init) =>
  new WebSocket(url, {
    headers: init.headers,
    // Both ends disable it: dev-server payloads are already compressed and
    // deflate's per-connection buffers break the protocol's bounded-memory
    // property (bead debugg_ai_mcp-xkoh.1.2 §0).
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_SIZE,
    followRedirects: false,
  }) as unknown as DebuggSocketLike;

/** Where a stream's bytes are allowed to go. Parsed once, at connect. */
interface DialTarget {
  host: string;
  port: number;
  tls: boolean;
}

interface TunnelState {
  host: string;
  hostname: string;
  publicUrl: string;
  tunnelId: string;
  token: string;
  relayUrl: string;
  dial: DialTarget;
  onDead?: (reason: string) => void;
  session?: TunnelSession;
  socket?: DebuggSocketLike;
  /** disconnect() was called: never reconnect again. */
  stopped: boolean;
  /** The tunnel can never come back (revoked, or auth failed on reconnect). */
  dead: boolean;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout;
}

class DebuggTransport implements TunnelTransport {
  readonly kind = 'debugg' as const;

  private readonly tunnels = new Map<string, TunnelState>();
  private readonly clientVersion: string | undefined;
  private readonly socketFactory: DebuggSocketFactory;
  private readonly backoffMs: number[];
  private readonly probeTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;

  constructor(opts: DebuggTransportOptions = {}) {
    this.clientVersion = opts.clientVersion;
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
    this.backoffMs = opts.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 20_000;
  }

  async connect(
    localAddr: string,
    hostname: string,
    token: string,
    opts: TunnelConnectOptions,
  ): Promise<string> {
    if (!opts.relayUrl) {
      throw terminal('debugg tunnel provisioning did not supply a relayUrl to connect to');
    }
    const host = hostname.toLowerCase();
    const state: TunnelState = {
      host,
      hostname,
      publicUrl: `https://${hostname}`,
      tunnelId: opts.tunnelId,
      token,
      relayUrl: opts.relayUrl,
      dial: parseLocalAddr(localAddr),
      onDead: opts.onDead,
      stopped: false,
      dead: false,
      reconnectAttempt: 0,
    };

    const { socket, session } = await this.handshake(state);
    this.adopt(state, socket, session);
    this.tunnels.set(host, state);
    // Published so probeTunnelHealth can health-check a hostname that resolves
    // only inside our VPC (services/tunnel/probeRegistry.ts).
    registerControlProbe(host, (path, probeOpts) => this.runProbe(state, path, probeOpts));
    logger.info(`debugg tunnel connected: ${state.publicUrl} -> ${describeDial(state.dial)}`);
    return state.publicUrl;
  }

  async disconnect(publicUrl: string): Promise<void> {
    const state = this.tunnels.get(hostOf(publicUrl));
    if (!state) return;
    state.stopped = true;
    this.teardown(state);
  }

  async probe(publicUrl: string, path: string, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
    const state = this.tunnels.get(hostOf(publicUrl));
    if (!state) return { error: 'CLOSED', elapsedMs: 0 };
    return this.runProbe(state, path, opts);
  }

  // ── Handshake ──────────────────────────────────────────────────────────────

  private handshake(state: TunnelState): Promise<{ socket: DebuggSocketLike; session: TunnelSession }> {
    const headers = buildHandshakeHeaders({
      tunnelId: state.tunnelId,
      tunnelKey: state.token,
      ...(this.clientVersion ? { clientVersion: this.clientVersion } : {}),
    });

    // The token rides in a header and NEVER in the URL: the ALB and nginx log
    // URLs, not headers.
    const socket = this.socketFactory(state.relayUrl, { headers });

    // ATTACH THE SESSION NOW, not on 'open', and not after connect() resolves.
    //
    // The server registers a tunnel the instant the handshake completes and may
    // send OPEN in that same tick, before any post-handshake wiring could run.
    // A session (or a 'stream' listener) attached even one microtask later
    // parses those frames into nothing: the browser request hangs with no error
    // on either side. It is invisible to a unit test that awaits connect()
    // first, and it lands precisely in the reconnect gap — a deploy or a
    // dropped socket is exactly what puts requests there — so in production it
    // reads as a rare, unexplainable hang instead of a clean failure.
    // (Cross-arc regression found by the tunnel server's integration tests.)
    const session = new TunnelSession(webSocketTransport(socket), { role: 'client' });
    session.on('stream', (stream: TunnelStream) => this.pipeToLocal(state, stream));
    // Non-fatal diagnostics. The session only emits these when something is
    // listening, and every stream's own 'error' is sunk by the session.
    session.on('error', (err: Error) => {
      logger.debug(`debugg tunnel ${state.hostname} session error: ${err.message}`);
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      let versionNegotiated = false;
      let upgraded = false;

      /**
       * Tear down a session that never made it into service, so its timers and
       * socket do not outlive the failed attempt. A socket that reached 101 can
       * be closed politely with a code; one that never upgraded has no
       * websocket to close, so the request is aborted instead (which is also
       * what `ws` needs after 'unexpected-response' — it does not clean up the
       * socket for you once you have registered that listener).
       */
      const abandon = (closeCode?: number) => {
        try {
          if (upgraded && closeCode !== undefined && !session.closed) {
            session.close(closeCode, 'handshake rejected');
          } else {
            socket.terminate();
          }
        } catch {
          /* already gone */
        }
      };

      const timer = setTimeout(() => {
        fail(egressError(state, 'the connection timed out', 'ETIMEDOUT'));
        abandon();
      }, this.handshakeTimeoutMs);
      (timer as { unref?: () => void }).unref?.();

      const done = () => { clearTimeout(timer); settled = true; };
      const fail = (err: TunnelTransportError) => {
        if (settled) return;
        done();
        reject(err);
      };

      socket.on('upgrade', (res: HandshakeResponseLike) => {
        if (settled) return;
        upgraded = true;
        const result = interpretHandshakeResponse(res.statusCode ?? 101, res.headers ?? {});
        if (result.ok) {
          versionNegotiated = true;
          return;
        }
        // A 101 we cannot negotiate: speaking anyway would corrupt the stream.
        abandon(ErrorCode.PROTOCOL_ERROR);
        fail(terminal(
          'the debugg tunnel server accepted the connection but did not echo a protocol version this ' +
          'client offered. Update @debugg-ai/debugg-ai-mcp.',
        ));
      });

      socket.on('open', () => {
        if (settled) return;
        upgraded = true;
        if (!versionNegotiated) {
          abandon(ErrorCode.PROTOCOL_ERROR);
          fail(terminal(
            'the debugg tunnel server accepted the connection without negotiating a protocol version. ' +
            'Update @debugg-ai/debugg-ai-mcp.',
          ));
          return;
        }
        done();
        resolve({ socket, session });
      });

      socket.on('unexpected-response', (_req: unknown, res: HandshakeResponseLike) => {
        const status = res?.statusCode ?? 0;
        const result = interpretHandshakeResponse(status, res?.headers ?? {});
        abandon();
        fail(handshakeFailureError(state, status, result.ok ? undefined : result.supported, result.ok ? true : result.retryable));
      });

      socket.on('error', (err: Error) => {
        // Before the upgrade completes this is always a connection-level
        // failure: DNS, TLS, refused, or blocked egress.
        if (!settled) abandon();
        fail(egressError(state, err.message, (err as NodeJS.ErrnoException).code));
      });
    });
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  private adopt(state: TunnelState, socket: DebuggSocketLike, session: TunnelSession): void {
    state.socket = socket;
    state.session = session;
    state.reconnectAttempt = 0;

    // 'stream' and 'error' were attached in handshake(), before the handshake
    // could deliver anything. Only the lifecycle wiring belongs here, because
    // it must NOT fire for a session that never made it into service.
    session.on('goaway', (info: { code: number; reason: string }) => {
      if (info.code === ErrorCode.REVOKED) {
        this.markDead(state, `the tunnel server reported it revoked (${info.reason || 'no reason given'})`);
        return;
      }
      // A deploy. Dial a replacement immediately (make-before-break) and let
      // this session drain its in-flight streams; its later close is ignored
      // because it is no longer the current one.
      this.scheduleReconnect(state, 0);
    });

    session.on('close', (info: { closeCode: number; reason: string }) => {
      if (state.session !== session) return; // superseded by a newer connection
      state.session = undefined;
      state.socket = undefined;
      if (state.stopped || state.dead) return;
      logger.warn(`debugg tunnel ${state.hostname} lost its control channel (${info.closeCode}); reconnecting`);
      this.scheduleReconnect(state);
    });
  }

  private scheduleReconnect(state: TunnelState, delayOverrideMs?: number): void {
    if (state.stopped || state.dead || state.reconnectTimer) return;
    const delay = delayOverrideMs ?? this.backoffMs[Math.min(state.reconnectAttempt, this.backoffMs.length - 1)];
    const timer = setTimeout(() => {
      state.reconnectTimer = undefined;
      void this.reconnect(state);
    }, delay);
    // Never hold the process open just because a tunnel wants to come back.
    (timer as { unref?: () => void }).unref?.();
    state.reconnectTimer = timer;
  }

  private async reconnect(state: TunnelState): Promise<void> {
    if (state.stopped || state.dead) return;
    try {
      const { socket, session } = await this.handshake(state);
      if (state.stopped || state.dead) {
        try { socket.close(CloseCode.GOING_AWAY, 'tunnel stopped'); } catch { /* ignore */ }
        return;
      }
      const previous = state.session;
      this.adopt(state, socket, session);
      // The old session keeps draining; it is closed by the server, and its
      // close event is ignored now that it is not the current one.
      if (previous && previous !== session) {
        void previous.goAway({ code: ErrorCode.GOING_AWAY, reason: 'replaced' }).catch(() => { /* best effort */ });
      }
      logger.info(`debugg tunnel ${state.hostname} reconnected`);
    } catch (err) {
      const error = err as TunnelTransportError;
      if (error?.retryable === false) {
        this.markDead(state, error.message);
        return;
      }
      state.reconnectAttempt++;
      this.scheduleReconnect(state);
    }
  }

  /**
   * The tunnel can never come back. TunnelManager evicts it, so the next call
   * re-provisions instead of reusing a corpse.
   */
  private markDead(state: TunnelState, reason: string): void {
    if (state.dead) return;
    state.dead = true;
    logger.warn(`debugg tunnel ${state.hostname} is permanently gone: ${reason}`);
    const notify = state.onDead;
    this.teardown(state);
    notify?.(reason);
  }

  private teardown(state: TunnelState): void {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = undefined;
    }
    unregisterControlProbe(state.host);
    this.tunnels.delete(state.host);
    const session = state.session;
    const socket = state.socket;
    state.session = undefined;
    state.socket = undefined;
    try {
      session?.close(ErrorCode.GOING_AWAY, 'client disconnect');
    } catch {
      /* already closed */
    }
    if (!session && socket) {
      try { socket.close(CloseCode.GOING_AWAY, 'client disconnect'); } catch { /* ignore */ }
    }
  }

  // ── The dial policy ────────────────────────────────────────────────────────

  private pipeToLocal(state: TunnelState, stream: TunnelStream): void {
    const { host, port, tls: useTls } = state.dial;
    const socket = useTls
      // Local dev certificates are self-signed by definition, and Caddy's own
      // upstream handling makes the same choice (insecure_skip_verify).
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });

    let established = false;
    const ready = useTls ? 'secureConnect' : 'connect';

    socket.once(ready, () => {
      established = true;
      stream.pipe(socket);
      socket.pipe(stream);
    });

    socket.on('error', () => {
      if (!established) {
        // The tunnel is fine; the app refused the connection.
        // The server renders DEBUGG_TUNNEL_UPSTREAM_REFUSED from this code and
        // tunnelDisposition keeps the tunnel.
        stream.reset(ErrorCode.UPSTREAM_UNREACHABLE);
      } else {
        stream.reset(ErrorCode.RESET);
      }
      socket.destroy();
    });

    stream.on('close', () => { socket.destroy(); });
  }

  private async runProbe(
    state: TunnelState,
    path: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<ProbeResult> {
    const session = state.session;
    // Mid-reconnect: report it as a closed channel rather than inventing a
    // verdict. probeTunnelHealth retries that, and a reconnect lands inside
    // its ladder.
    if (!session) return { error: 'CLOSED', elapsedMs: 0 };
    return session.probe(path, { timeoutMs: opts.timeoutMs ?? this.probeTimeoutMs });
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────

function tunnelError(message: string, retryable: boolean): TunnelTransportError {
  const err = new Error(message) as TunnelTransportError;
  err.retryable = retryable;
  return err;
}

/** Terminal for this token or this build: retrying sends the same thing again. */
function terminal(message: string): TunnelTransportError {
  return tunnelError(message, false);
}

function handshakeFailureError(
  state: TunnelState,
  status: number,
  supported: number[] | undefined,
  retryable: boolean,
): TunnelTransportError {
  switch (status) {
    case 401:
      // The word "authtoken" is load-bearing: TunnelManager's connect ladder
      // matches it to stop retrying and render its "invalid auth token"
      // message.
      return terminal(
        'the debugg tunnel server rejected the authtoken (HTTP 401) — the tunnel key is invalid, ' +
        'expired or revoked. A new one is provisioned on the next call.',
      );
    case 400:
      return terminal(
        `the debugg tunnel server rejected the tunnel id "${state.tunnelId}" (HTTP 400)`,
      );
    case 426:
      return terminal(
        'this MCP speaks a tunnel protocol version the server no longer supports (HTTP 426' +
        `${supported ? `, server supports ${supported.join(', ')}` : ''}). ` +
        'Update @debugg-ai/debugg-ai-mcp.',
      );
    case 407:
      return terminal(
        `an HTTP proxy at your network edge intercepted the tunnel connection to ${hostOf(state.relayUrl)} ` +
        'and demanded authentication (HTTP 407). The tunnel needs a DIRECT outbound HTTPS (443) ' +
        'connection; proxies are not supported.',
      );
    default:
      return tunnelError(
        `the debugg tunnel server refused the connection (HTTP ${status})`,
        retryable,
      );
  }
}

/**
 * A connection-level failure reaching the relay. This client does NOT honour
 * HTTPS_PROXY (the retired ngrok agent did, which is the one capability lost
 * in the cutover — design §5 "open gap"), so the message says plainly what has
 * to be allowed instead of reading as a generic tunnel error.
 */
function egressError(state: TunnelState, detail: string, code?: string): TunnelTransportError {
  const relayHost = hostOf(state.relayUrl);
  const proxyVar = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'].find((name) => process.env[name]);
  const proxyNote = proxyVar
    ? ` This environment sets ${proxyVar}, which the tunnel connection does NOT use — HTTP(S) proxies are not supported for it.`
    : ' HTTP(S) proxies are not supported for the tunnel connection.';
  return tunnelError(
    `could not reach the debugg tunnel server at ${relayHost} (${code ?? 'connection failed'}: ${detail}). ` +
    `Testing a local app needs a direct outbound HTTPS connection to ${relayHost} on port 443 — ` +
    `allow it in your firewall, VPN or container network rules.${proxyNote}`,
    true,
  );
}

// ── Address handling ─────────────────────────────────────────────────────────

/**
 * The five forms TunnelManager registers: Caddy's `http://127.0.0.1:<p>` for a
 * session tunnel (in Docker too — Caddy runs in the same container), and
 * `127.0.0.1:<p>`, `host.docker.internal:<p>`, `https://localhost:<p>` or
 * `https://host.docker.internal:<p>` for the dedicated test_suite path.
 */
function parseLocalAddr(localAddr: string): DialTarget {
  const schemed = /^(https?):\/\//i.exec(localAddr);
  if (schemed) {
    const url = new URL(localAddr);
    const useTls = schemed[1].toLowerCase() === 'https';
    return {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : (useTls ? 443 : 80),
      tls: useTls,
    };
  }
  const lastColon = localAddr.lastIndexOf(':');
  if (lastColon === -1) {
    throw terminal(`debugg tunnel cannot dial "${localAddr}": no port`);
  }
  const host = localAddr.slice(0, lastColon).replace(/^\[|\]$/g, '');
  const port = Number(localAddr.slice(lastColon + 1));
  if (!Number.isInteger(port) || port <= 0) {
    throw terminal(`debugg tunnel cannot dial "${localAddr}": no port`);
  }
  return { host, port, tls: false };
}

function describeDial(dial: DialTarget): string {
  return `${dial.tls ? 'https' : 'http'}://${dial.host}:${dial.port}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

export function createDebuggTransport(options: DebuggTransportOptions = {}): TunnelTransport {
  return new DebuggTransport(options);
}
