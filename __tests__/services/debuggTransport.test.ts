/**
 * debuggTransport — the pure-TS client for the debugg tunnel server
 * (bead debugg_ai_mcp-xkoh.5.3, spec bead debugg_ai_mcp-xkoh.1.2).
 *
 * The websocket is faked through the transport's socketFactory seam, so these
 * tests are hermetic and need no `ws` server. Frames are hand-encoded from the
 * spec (type u8 | streamId u32 BE | payload) rather than built with the codec:
 * the codec is the protocol arc's unit under test, and hand-encoding keeps
 * these tests honest about the wire.
 *
 * Local dialling IS exercised for real, against a throwaway HTTP server on
 * loopback, because "dial only the address TunnelManager registered" is the
 * SSRF boundary of this arc and a mock would prove nothing.
 *
 * RED on purpose: createDebuggTransport() is a stub.
 */

import { jest } from '@jest/globals';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { createDebuggTransport, type DebuggSocketLike, type HandshakeResponseLike } from '../../services/tunnel/debuggTransport.js';
import { FrameType, ErrorCode, CloseCode } from '../../services/tunnel/protocol/index.js';

const RELAY = 'wss://api.debugg.ai/tunnel/v1/connect';
const TUNNEL_ID = 'tid-1';
const HOSTNAME = `${TUNNEL_ID}.tunnel.debugg.ai`;
const PUBLIC_URL = `https://${HOSTNAME}`;
const TOKEN = 'tunnel-key-secret';

const tick = () => new Promise((r) => setImmediate(r));

// ── Frame helpers (spec §2) ──────────────────────────────────────────────────

function frame(type: number, streamId: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const buf = Buffer.alloc(5 + payload.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(streamId, 1);
  Buffer.from(payload).copy(buf, 5);
  return new Uint8Array(buf);
}

const jsonPayload = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value), 'utf8'));

function u16(value: number): Uint8Array {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return new Uint8Array(b);
}

function parseFrame(bytes: Uint8Array) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { type: b.readUInt8(0), streamId: b.readUInt32BE(1), payload: b.subarray(5) };
}

// ── Fake websocket ───────────────────────────────────────────────────────────

class FakeSocket implements DebuggSocketLike {
  readonly sent: Uint8Array[] = [];
  closedWith?: { code?: number; reason?: string };
  terminated = false;
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor(readonly url: string, readonly init: { headers: Record<string, string> }) {}

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  send(data: Uint8Array, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.emit('close', code ?? 1005, Buffer.from(reason ?? ''));
  }

  terminate(): void {
    this.terminated = true;
    this.emit('close', 1006, Buffer.alloc(0));
  }

  // — test drivers —
  emit(event: string, ...args: any[]): void {
    (this.listeners.get(event) ?? []).forEach((l) => l(...args));
  }

  /** A successful upgrade, echoing the protocol version the server selected. */
  accept(protocol = '1'): void {
    const res: HandshakeResponseLike = {
      statusCode: 101,
      headers: { 'x-debugg-tunnel-protocol': protocol },
    };
    this.emit('upgrade', res);
    this.emit('open');
  }

  /** A non-101 handshake response (400 / 401 / 426 / 5xx). */
  reject(statusCode: number, headers: Record<string, string> = {}): void {
    this.emit('unexpected-response', {}, { statusCode, headers });
  }

  deliver(f: Uint8Array): void {
    this.emit('message', Buffer.from(f), true);
  }

  frames() {
    return this.sent.map(parseFrame);
  }
}

function harness(opts: { probeTimeoutMs?: number; reconnectBackoffMs?: number[] } = {}) {
  const sockets: FakeSocket[] = [];
  const transport = createDebuggTransport({
    clientVersion: 'debugg-ai-mcp/9.9.9',
    reconnectBackoffMs: opts.reconnectBackoffMs ?? [1, 1, 1],
    probeTimeoutMs: opts.probeTimeoutMs,
    socketFactory: (url, init) => {
      const s = new FakeSocket(url, init);
      sockets.push(s);
      return s;
    },
  });
  return { transport, sockets };
}

/** connect() + a successful handshake. */
async function connected(
  h: ReturnType<typeof harness>,
  localAddr = 'http://127.0.0.1:41000',
  onDead?: (reason: string) => void,
) {
  const pending = h.transport.connect(localAddr, HOSTNAME, TOKEN, {
    tunnelId: TUNNEL_ID,
    relayUrl: RELAY,
    onDead,
  });
  await tick();
  h.sockets[0].accept();
  const url = await pending;
  return url;
}

// ── Handshake ────────────────────────────────────────────────────────────────

describe('handshake', () => {
  test('dials the relay URL with the protocol headers', async () => {
    const h = harness();
    const url = await connected(h);

    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).toBe(RELAY);
    expect(h.sockets[0].init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'X-Debugg-Tunnel-Id': TUNNEL_ID,
      'X-Debugg-Tunnel-Protocol': '1',
      'X-Debugg-Tunnel-Client-Version': 'debugg-ai-mcp/9.9.9',
    });
    expect(url).toBe(PUBLIC_URL);
  });

  test('the tunnel key never appears in the URL — ALB and nginx log URLs, not headers', async () => {
    const h = harness();
    await connected(h);

    expect(h.sockets[0].url).not.toContain(TOKEN);
  });

  test('a 101 that echoes no protocol version is refused', async () => {
    const h = harness();
    const pending = h.transport.connect('http://127.0.0.1:41000', HOSTNAME, TOKEN, { tunnelId: TUNNEL_ID, relayUrl: RELAY });
    await tick();
    h.sockets[0].emit('upgrade', { statusCode: 101, headers: {} });
    h.sockets[0].emit('open');

    await expect(pending).rejects.toThrow();
    expect(h.sockets[0].closedWith?.code).toBe(CloseCode.PROTOCOL_ERROR);
  });

  test('a 101 echoing a version we never offered is refused', async () => {
    const h = harness();
    const pending = h.transport.connect('http://127.0.0.1:41000', HOSTNAME, TOKEN, { tunnelId: TUNNEL_ID, relayUrl: RELAY });
    await tick();
    h.sockets[0].accept('2');

    await expect(pending).rejects.toThrow();
  });
});

describe('handshake rejections', () => {
  async function rejectWith(status: number, headers: Record<string, string> = {}) {
    const h = harness();
    const pending = h.transport.connect('http://127.0.0.1:41000', HOSTNAME, TOKEN, { tunnelId: TUNNEL_ID, relayUrl: RELAY });
    await tick();
    h.sockets[0].reject(status, headers);
    const error = await pending.then(() => null, (e) => e);
    await tick();
    return { h, error };
  }

  test('401 is terminal and surfaces as an auth-token failure, so the ladder does not loop', async () => {
    const { h, error } = await rejectWith(401);

    // "authtoken" is what TunnelManager matches to render today's
    // "Failed to create tunnel: invalid auth token." message.
    expect(String(error.message)).toMatch(/authtoken/i);
    expect(String(error.message)).toContain('401');
    expect(error.retryable).toBe(false);
    expect(h.sockets).toHaveLength(1);
  });

  test('426 is terminal and tells the user to update the MCP', async () => {
    const { error } = await rejectWith(426, { 'x-debugg-tunnel-supported': '1' });

    expect(error.retryable).toBe(false);
    expect(String(error.message)).toMatch(/426|protocol version/i);
  });

  test('400 (bad tunnel id) is terminal — a retry sends the same id', async () => {
    const { error } = await rejectWith(400);
    expect(error.retryable).toBe(false);
  });

  test('a 5xx is retryable, so TunnelManager retry ladder can do its job', async () => {
    const { error } = await rejectWith(503);
    expect(error.retryable).not.toBe(false);
  });

  test('a socket error before the upgrade is retryable', async () => {
    const h = harness();
    const pending = h.transport.connect('http://127.0.0.1:41000', HOSTNAME, TOKEN, { tunnelId: TUNNEL_ID, relayUrl: RELAY });
    await tick();
    h.sockets[0].emit('error', Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }));

    const error = await pending.then(() => null, (e) => e);
    expect(error.retryable).not.toBe(false);
  });
});

// ── Blocked egress ───────────────────────────────────────────────────────────

describe('a connection that never reaches the relay says what has to be allowed', () => {
  // This is the ONE user-visible regression versus ngrok: the ngrok agent
  // honours HTTPS_PROXY and this client does not (owner decision: accepted
  // risk). A generic "tunnel failed" would send someone hunting in the wrong
  // place, so the message names the host, the port, and the proxy limitation.
  const ORIGINAL_PROXY = process.env.HTTPS_PROXY;

  afterEach(() => {
    if (ORIGINAL_PROXY === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = ORIGINAL_PROXY;
  });

  async function failConnect(code: string) {
    const h = harness();
    const pending = h.transport.connect('http://127.0.0.1:41000', HOSTNAME, TOKEN, { tunnelId: TUNNEL_ID, relayUrl: RELAY });
    await tick();
    h.sockets[0].emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code }));
    return pending.then(() => null, (e) => e);
  }

  test('names the host and the outbound 443 requirement, and stays retryable', async () => {
    delete process.env.HTTPS_PROXY;
    const error = await failConnect('ECONNREFUSED');

    expect(error.message).toContain('api.debugg.ai');
    expect(error.message).toContain('443');
    expect(error.message).toMatch(/outbound/i);
    expect(error.message).toMatch(/firewall|VPN|network/i);
    expect(error.message).toMatch(/prox/i);
    // Egress can be restored without re-provisioning, so the ladder may retry.
    expect(error.retryable).not.toBe(false);
  });

  test('when a proxy env var is set, it says plainly that the tunnel ignores it', async () => {
    process.env.HTTPS_PROXY = 'http://corp-proxy:8080';
    const error = await failConnect('ETIMEDOUT');

    expect(error.message).toContain('HTTPS_PROXY');
    expect(error.message).toMatch(/not use|not supported/i);
  });
});

// ── Token lifetime ───────────────────────────────────────────────────────────

describe('a live tunnel keeps reconnecting with the same token', () => {
  test('repeated drops re-send the original tunnel key and never declare the tunnel dead', async () => {
    // expires_at gates the FIRST connect, not reconnects (up to the server's
    // 24h hard maximum), so a long run survives a tunnel-server deploy. The
    // client must therefore never expire a tunnel on its own — only a server
    // rejection (401/400/426) or a REVOKED goaway ends one.
    const h = harness({ reconnectBackoffMs: [1] });
    const onDead = jest.fn();
    await connected(h, 'http://127.0.0.1:41000', onDead);

    for (let i = 0; i < 3; i++) {
      h.sockets[h.sockets.length - 1].terminate();
      await new Promise((r) => setTimeout(r, 30));
      h.sockets[h.sockets.length - 1].accept();
      await tick();
    }

    expect(h.sockets).toHaveLength(4);
    for (const socket of h.sockets) {
      expect(socket.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(socket.init.headers['X-Debugg-Tunnel-Id']).toBe(TUNNEL_ID);
    }
    expect(onDead).not.toHaveBeenCalled();
  });
});

// ── The dial boundary ────────────────────────────────────────────────────────

describe('a stream is dialled at the registered local address and nowhere else', () => {
  let server: http.Server;
  let port: number;
  let received: Array<{ url?: string; host?: string }>;

  beforeEach(async () => {
    received = [];
    server = http.createServer((req, res) => {
      received.push({ url: req.url, host: req.headers.host });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  test('OPEN metadata cannot redirect the dial — the request lands on the registered origin', async () => {
    const h = harness();
    await connected(h, `http://127.0.0.1:${port}`);

    // Hostile metadata: a server (or anything that can inject a frame) asking
    // the client to dial the cloud metadata endpoint. The client must ignore
    // every address-shaped field and dial only what it was given at connect.
    h.sockets[0].deliver(frame(FrameType.OPEN, 1, jsonPayload({
      kind: 'http',
      requestId: 'r1',
      target: 'http://169.254.169.254/latest/meta-data/',
      host: '169.254.169.254',
      port: 80,
    })));
    h.sockets[0].deliver(frame(FrameType.DATA, 1, new Uint8Array(Buffer.from(
      'GET /app HTTP/1.1\r\nHost: tid-1.tunnel.debugg.ai\r\nConnection: close\r\n\r\n', 'utf8',
    ))));

    await new Promise((r) => setTimeout(r, 150));

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/app');
    // The Host header rides through untouched, exactly as the ngrok agent does.
    expect(received[0].host).toBe('tid-1.tunnel.debugg.ai');
  });

  test('a stream that arrives in the SAME TICK as the handshake is not dropped', async () => {
    // Cross-arc regression (found by the server arc's integration tests): the
    // server registers a tunnel the instant the handshake completes and may
    // send OPEN immediately — before connect() has resolved and before any
    // post-handshake wiring could run. If the session or its 'stream' listener
    // is attached any later than the socket itself, those frames are parsed
    // into nothing and the browser request hangs with no error anywhere.
    //
    // This is the reconnect gap: exactly when a deploy or a dropped socket
    // puts requests there, so in production it reads as a rare unexplainable
    // hang rather than a clean failure.
    const h = harness();
    const pending = h.transport.connect(`http://127.0.0.1:${port}`, HOSTNAME, TOKEN, {
      tunnelId: TUNNEL_ID,
      relayUrl: RELAY,
    });
    await tick();

    const socket = h.sockets[0];
    socket.accept();
    // No await between the handshake completing and these frames: the server
    // is allowed to be this fast.
    socket.deliver(frame(FrameType.OPEN, 1, jsonPayload({ kind: 'http' })));
    socket.deliver(frame(FrameType.DATA, 1, new Uint8Array(Buffer.from(
      'GET /raced HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', 'utf8',
    ))));

    await pending;
    await new Promise((r) => setTimeout(r, 200));

    expect(received.map((r) => r.url)).toContain('/raced');
  });

  test('bytes the local app returns are sent back as DATA on the same stream', async () => {
    const h = harness();
    await connected(h, `http://127.0.0.1:${port}`);

    h.sockets[0].deliver(frame(FrameType.OPEN, 1, jsonPayload({ kind: 'http' })));
    h.sockets[0].deliver(frame(FrameType.DATA, 1, new Uint8Array(Buffer.from(
      'GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', 'utf8',
    ))));

    await new Promise((r) => setTimeout(r, 150));

    const data = h.sockets[0].frames().filter((f) => f.type === FrameType.DATA && f.streamId === 1);
    expect(data.length).toBeGreaterThan(0);
    expect(Buffer.concat(data.map((f) => f.payload)).toString('utf8')).toContain('hello');
  });

  test('a local app that refuses the connection gets RST(UPSTREAM_UNREACHABLE), and the tunnel stays up', async () => {
    // Closed port: the ERR_NGROK_8012 analogue. The server renders
    // DEBUGG_TUNNEL_UPSTREAM_REFUSED from this code, and tunnelDisposition
    // keeps the tunnel, because the tunnel is not what failed.
    const closedPort = port;
    await new Promise<void>((r) => server.close(() => r()));
    server = http.createServer(() => {}); // replaced in afterEach; never listened

    const h = harness();
    await connected(h, `http://127.0.0.1:${closedPort}`);

    h.sockets[0].deliver(frame(FrameType.OPEN, 1, jsonPayload({ kind: 'http' })));
    await new Promise((r) => setTimeout(r, 200));

    const rst = h.sockets[0].frames().find((f) => f.type === FrameType.RST && f.streamId === 1);
    expect(rst).toBeDefined();
    expect(Buffer.from(rst!.payload).readUInt16BE(0)).toBe(ErrorCode.UPSTREAM_UNREACHABLE);
    expect(h.sockets[0].closedWith).toBeUndefined();
    expect(h.sockets).toHaveLength(1);
  });
});

// ── Reconnect ────────────────────────────────────────────────────────────────

describe('reconnect keeps the same tunnel and the same public URL', () => {
  test('GOAWAY(GOING_AWAY) dials a new connection before the old one finishes draining', async () => {
    const h = harness();
    const url = await connected(h);

    h.sockets[0].deliver(frame(FrameType.GOAWAY, 0, u16(ErrorCode.GOING_AWAY)));
    await tick();
    await new Promise((r) => setTimeout(r, 20));

    expect(h.sockets.length).toBeGreaterThanOrEqual(2);
    expect(h.sockets[1].init.headers['X-Debugg-Tunnel-Id']).toBe(TUNNEL_ID);
    expect(h.sockets[1].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // The public URL is a property of the tunnel id, not of the socket.
    expect(url).toBe(PUBLIC_URL);
  });

  test('an abrupt drop reconnects after a backoff', async () => {
    const h = harness();
    await connected(h);

    h.sockets[0].terminate();
    await new Promise((r) => setTimeout(r, 50));

    expect(h.sockets).toHaveLength(2);
    h.sockets[1].accept();
    await tick();
    expect(h.sockets[1].closedWith).toBeUndefined();
  });

  test('GOAWAY(REVOKED) is the end of the tunnel: no reconnect, and TunnelManager is told', async () => {
    const h = harness();
    const onDead = jest.fn();
    await connected(h, 'http://127.0.0.1:41000', onDead);

    h.sockets[0].deliver(frame(FrameType.GOAWAY, 0, u16(ErrorCode.REVOKED)));
    h.sockets[0].close(CloseCode.REVOKED, 'revoked');
    await new Promise((r) => setTimeout(r, 50));

    expect(h.sockets).toHaveLength(1);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  test('a 401 on reconnect is permanent: stop trying and report the tunnel dead', async () => {
    const h = harness();
    const onDead = jest.fn();
    await connected(h, 'http://127.0.0.1:41000', onDead);

    h.sockets[0].terminate();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sockets).toHaveLength(2);

    h.sockets[1].reject(401);
    await new Promise((r) => setTimeout(r, 50));

    expect(h.sockets).toHaveLength(2);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  test('disconnect() closes the socket and never reconnects', async () => {
    const h = harness();
    await connected(h);

    await h.transport.disconnect(PUBLIC_URL);
    await new Promise((r) => setTimeout(r, 50));

    expect(h.sockets[0].closedWith).toBeDefined();
    expect(h.sockets).toHaveLength(1);
  });
});

// ── PROBE ────────────────────────────────────────────────────────────────────

describe('probe over the control channel', () => {
  test('sends PROBE with the path and resolves the server PROBE_RESULT', async () => {
    const h = harness();
    await connected(h);

    const pending = h.transport.probe!(PUBLIC_URL, '/dashboard?a=b');
    await tick();

    const probe = h.sockets[0].frames().find((f) => f.type === FrameType.PROBE);
    expect(probe).toBeDefined();
    expect(JSON.parse(Buffer.from(probe!.payload).toString('utf8'))).toEqual({ path: '/dashboard?a=b' });

    h.sockets[0].deliver(frame(FrameType.PROBE_RESULT, probe!.streamId, jsonPayload({ status: 200, elapsedMs: 12 })));

    await expect(pending).resolves.toMatchObject({ status: 200, elapsedMs: 12 });
  });

  test('a probe that is never answered resolves as TIMEOUT — the probe API never throws', async () => {
    const h = harness({ probeTimeoutMs: 20 });
    await connected(h);

    await expect(h.transport.probe!(PUBLIC_URL, '/')).resolves.toMatchObject({ error: 'TIMEOUT' });
  });

  test('a session that closes mid-probe resolves the probe as CLOSED', async () => {
    const h = harness();
    await connected(h);

    const pending = h.transport.probe!(PUBLIC_URL, '/');
    await tick();
    h.sockets[0].terminate();

    await expect(pending).resolves.toMatchObject({ error: 'CLOSED' });
  });
});

// ── The probe registry seam ──────────────────────────────────────────────────

describe('the control prober is published for probeTunnelHealth', () => {
  test('registered on connect, removed on disconnect', async () => {
    const registry = await import('../../services/tunnel/probeRegistry.js');
    const h = harness();
    await connected(h);

    expect(typeof registry.getControlProbe(PUBLIC_URL)).toBe('function');

    await h.transport.disconnect(PUBLIC_URL);

    expect(registry.getControlProbe(PUBLIC_URL)).toBeUndefined();
  });
});
