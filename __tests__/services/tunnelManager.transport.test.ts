/**
 * TunnelManager picks a transport from the provision response
 * (bead debugg_ai_mcp-xkoh.5.3, requirements xkoh.5.2 R2/R3/R5/R10).
 *
 * Everything above the transport is unchanged: the same Caddy instance per
 * session key, the same retry ladder, the same idle timer, the same
 * stopTunnel ordering. Only the connect/disconnect step is swapped.
 *
 * This file NEVER exercises the ngrok path, which is what lets it assert the
 * strongest requirement of the arc: on a debugg tunnel the `ngrok` package is
 * never even imported, so no binary is downloaded and no agent is spawned.
 * The module factory below counts loads; ESM caches it, so one count covers
 * the whole file.
 *
 * RED on purpose: TunnelManager has no transport seam yet — it calls
 * ngrok.connect() directly, and ensureInitialized()/ensureAgentSession() run
 * on every path.
 */

import { jest } from '@jest/globals';
import type { CaddyProxy, UpstreamTarget } from '../../services/caddy/caddyProxy.js';

let ngrokModuleLoads = 0;
const mockNgrokConnect = jest.fn<() => Promise<string>>();

jest.unstable_mockModule('ngrok', () => {
  ngrokModuleLoads++;
  return {
    connect: mockNgrokConnect,
    disconnect: jest.fn(),
    getApi: jest.fn(),
    default: { connect: mockNgrokConnect, disconnect: jest.fn(), getApi: jest.fn() },
  };
});

const mockStartAgentSession = jest.fn(async (opts: any) => { opts.onStatusChange('connected'); });
jest.unstable_mockModule('../../services/ngrok/ngrokAgentSession.js', () => ({
  startAgentSession: mockStartAgentSession,
}));

let TunnelManagerClass: typeof import('../../services/ngrok/tunnelManager.js').default;
let createInMemoryRegistry: typeof import('../../services/ngrok/tunnelRegistry.js').createInMemoryRegistry;
let Telemetry: typeof import('../../utils/telemetry.js').Telemetry;
let TelemetryEvents: typeof import('../../utils/telemetry.js').TelemetryEvents;

beforeAll(async () => {
  ({ default: TunnelManagerClass } = await import('../../services/ngrok/tunnelManager.js'));
  ({ createInMemoryRegistry } = await import('../../services/ngrok/tunnelRegistry.js'));
  ({ Telemetry, TelemetryEvents } = await import('../../utils/telemetry.js'));
});

const ORIGINAL_DOCKER = process.env.DOCKER_CONTAINER;

beforeEach(() => {
  jest.clearAllMocks();
  mockNgrokConnect.mockResolvedValue('https://should-never-be-used.ngrok.debugg.ai' as any);
});

afterEach(() => {
  if (ORIGINAL_DOCKER === undefined) delete process.env.DOCKER_CONTAINER;
  else process.env.DOCKER_CONTAINER = ORIGINAL_DOCKER;
});

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeFakeCaddy(localOrigin = 'http://127.0.0.1:41000'): CaddyProxy {
  const calls: UpstreamTarget[] = [];
  return {
    ensureStarted: jest.fn(async () => ({ localOrigin, localPort: 41000, adminPort: 41001 })),
    setUpstream: jest.fn(async (t: UpstreamTarget) => { calls.push(t); }),
    isHealthy: jest.fn(async () => true),
    stop: jest.fn(async () => {}),
    onPortChanged: jest.fn(),
  } as unknown as CaddyProxy;
}

interface FakeTransport {
  kind: 'debugg';
  connect: jest.Mock<any>;
  disconnect: jest.Mock<any>;
  probe: jest.Mock<any>;
  /** onDead handed to connect(), so a test can simulate a permanent drop. */
  lastOnDead?: (reason: string) => void;
}

function makeFakeDebuggTransport(
  connectImpl?: (localAddr: string, hostname: string, token: string, opts: any) => Promise<string>,
): FakeTransport {
  const t: FakeTransport = {
    kind: 'debugg',
    connect: jest.fn(async (localAddr: any, hostname: any, token: any, opts: any) => {
      t.lastOnDead = opts?.onDead;
      if (connectImpl) return connectImpl(localAddr, hostname, token, opts);
      return `https://${hostname}`;
    }) as any,
    disconnect: jest.fn(async () => {}) as any,
    probe: jest.fn(async () => ({ status: 200, elapsedMs: 1 })) as any,
  };
  return t;
}

function freshTm(transport: FakeTransport, caddy: CaddyProxy = makeFakeCaddy()) {
  const tm = new TunnelManagerClass(createInMemoryRegistry());
  tm.connectBackoffMs = [1, 1];
  tm.caddyFactory = () => caddy;
  // The transport seam: a map of kind -> implementation, in the same style as
  // caddyFactory / agentSessionStarter.
  (tm as any).transports = { debugg: transport };
  return tm;
}

const DEBUGG = {
  transport: 'debugg' as const,
  relayUrl: 'wss://api.debugg.ai/tunnel/v1/connect',
  tunnelDomain: 'tunnel.debugg.ai',
};

// ── Session tunnels ──────────────────────────────────────────────────────────

describe('a debugg provision drives the debugg transport', () => {
  test('connect gets Caddy loopback, the debugg hostname, the tunnel key and the relay URL', async () => {
    const transport = makeFakeDebuggTransport();
    const tm = freshTm(transport);

    const info = await (tm as any).ensureSessionTunnel('sess-a', 'tunnel-key-1', 'my-id', 'kid-1', undefined, DEBUGG);

    expect(transport.connect).toHaveBeenCalledTimes(1);
    const [localAddr, hostname, token, opts] = transport.connect.mock.calls[0] as any[];
    expect(localAddr).toBe('http://127.0.0.1:41000');
    expect(hostname).toBe('my-id.tunnel.debugg.ai');
    expect(token).toBe('tunnel-key-1');
    expect(opts).toMatchObject({ tunnelId: 'my-id', relayUrl: DEBUGG.relayUrl });
    expect(info.tunnelUrl).toBe('https://my-id.tunnel.debugg.ai');
    expect(tm.getSessionTunnelInfo('sess-a')).toBe(info);
  });

  test('the ngrok package is never imported and the agent is never pre-warmed', async () => {
    const transport = makeFakeDebuggTransport();
    const tm = freshTm(transport);

    await (tm as any).ensureSessionTunnel('sess-b', 'tunnel-key-1', 'my-id', undefined, undefined, DEBUGG);

    expect(ngrokModuleLoads).toBe(0);
    expect(mockNgrokConnect).not.toHaveBeenCalled();
    expect(mockStartAgentSession).not.toHaveBeenCalled();
  });

  test('in Docker the session tunnel still dials the in-container Caddy loopback', async () => {
    process.env.DOCKER_CONTAINER = 'true';
    const transport = makeFakeDebuggTransport();
    const tm = freshTm(transport);

    await (tm as any).ensureSessionTunnel('sess-c', 'k', 'my-id', undefined, undefined, DEBUGG);

    expect((transport.connect.mock.calls[0] as any[])[0]).toBe('http://127.0.0.1:41000');
  });

  test('telemetry tags the transport', async () => {
    const spy = jest.spyOn(Telemetry, 'capture');
    const transport = makeFakeDebuggTransport();
    const tm = freshTm(transport);

    await (tm as any).ensureSessionTunnel('sess-d', 'k', 'my-id', undefined, undefined, DEBUGG);

    expect(spy).toHaveBeenCalledWith(
      TelemetryEvents.TUNNEL_PROVISIONED,
      expect.objectContaining({ transport: 'debugg' }),
    );
    spy.mockRestore();
  });
});

// ── The dedicated (test_suite run) path ──────────────────────────────────────

describe('the dedicated tunnel path under debugg', () => {
  test('uses the PROVISIONED tunnel id — a client-minted uuid is not bound to the token', async () => {
    const transport = makeFakeDebuggTransport();
    const tm = freshTm(transport);

    const result = await (tm as any).acquireDedicatedTunnel(
      'http://localhost:3000/deep?a=b',
      'tunnel-key-1',
      'kid-1',
      undefined,
      { ...DEBUGG, tunnelId: 'prov-id' },
    );

    expect(result.tunnelId).toBe('prov-id');
    expect(result.url).toBe('https://prov-id.tunnel.debugg.ai/deep?a=b');
    const [localAddr, hostname] = transport.connect.mock.calls[0] as any[];
    expect(localAddr).toBe('127.0.0.1:3000');
    expect(hostname).toBe('prov-id.tunnel.debugg.ai');
  });

  test('dials the app directly, with the existing Docker and HTTPS matrix', async () => {
    const transport = makeFakeDebuggTransport();
    const tm = freshTm(transport);

    await (tm as any).acquireDedicatedTunnel('https://localhost:3000', 'k', undefined, undefined, { ...DEBUGG, tunnelId: 'a' });
    expect((transport.connect.mock.calls[0] as any[])[0]).toBe('https://localhost:3000');

    process.env.DOCKER_CONTAINER = 'true';
    await (tm as any).acquireDedicatedTunnel('http://localhost:3001', 'k', undefined, undefined, { ...DEBUGG, tunnelId: 'b' });
    expect((transport.connect.mock.calls[1] as any[])[0]).toBe('host.docker.internal:3001');
  });
});

// ── Errors ───────────────────────────────────────────────────────────────────

describe('connect failures', () => {
  test('a 401 is not retried and surfaces as today invalid-auth-token error', async () => {
    const transport = makeFakeDebuggTransport(async () => {
      throw Object.assign(new Error('debugg tunnel rejected the authtoken (HTTP 401)'), { retryable: false });
    });
    const tm = freshTm(transport);

    await expect(
      (tm as any).ensureSessionTunnel('sess-e', 'k', 'my-id', undefined, undefined, DEBUGG),
    ).rejects.toThrow(/invalid auth token/);
    expect(transport.connect).toHaveBeenCalledTimes(1);
  });

  test('an error flagged non-retryable (e.g. 426 protocol version) stops the ladder immediately', async () => {
    const transport = makeFakeDebuggTransport(async () => {
      throw Object.assign(
        new Error('tunnel protocol version 1 not supported (HTTP 426) — update @debugg-ai/debugg-ai-mcp'),
        { retryable: false },
      );
    });
    const tm = freshTm(transport);

    await expect(
      (tm as any).ensureSessionTunnel('sess-f', 'k', 'my-id', undefined, undefined, DEBUGG),
    ).rejects.toThrow(/426|protocol version/);
    expect(transport.connect).toHaveBeenCalledTimes(1);
  });

  test('a transient failure still gets the existing 3-attempt ladder', async () => {
    let attempts = 0;
    const transport = makeFakeDebuggTransport(async (_a, hostname) => {
      attempts++;
      if (attempts < 3) throw new Error('socket hang up');
      return `https://${hostname}`;
    });
    const tm = freshTm(transport);

    const info = await (tm as any).ensureSessionTunnel('sess-g', 'k', 'my-id', undefined, undefined, DEBUGG);

    expect(attempts).toBe(3);
    expect(info.tunnelUrl).toBe('https://my-id.tunnel.debugg.ai');
    expect(mockStartAgentSession).not.toHaveBeenCalled();
  });
});

// ── Teardown and death ───────────────────────────────────────────────────────

describe('teardown', () => {
  test('stopTunnel disconnects through the transport and revokes the backend tunnel', async () => {
    const transport = makeFakeDebuggTransport();
    const tm = freshTm(transport);
    const revokeKey = jest.fn(async () => {});

    const info = await (tm as any).ensureSessionTunnel('sess-h', 'k', 'my-id', 'kid-1', revokeKey, DEBUGG);
    await tm.stopTunnel(info.tunnelId);

    expect(transport.disconnect).toHaveBeenCalledWith('https://my-id.tunnel.debugg.ai');
    expect(revokeKey).toHaveBeenCalledTimes(1);
    expect(tm.getTunnelInfo('my-id')).toBeUndefined();
    expect(tm.getSessionTunnelInfo('sess-h')).toBeUndefined();
    expect(ngrokModuleLoads).toBe(0);
  });

  test('a transport that reports permanent death evicts the tunnel, so the next call re-provisions', async () => {
    const transport = makeFakeDebuggTransport();
    const tm = freshTm(transport);

    await (tm as any).ensureSessionTunnel('sess-i', 'k', 'my-id', undefined, undefined, DEBUGG);
    expect(typeof transport.lastOnDead).toBe('function');

    transport.lastOnDead!('unauthorized on reconnect');
    await new Promise((r) => setImmediate(r));

    expect(tm.getSessionTunnelInfo('sess-i')).toBeUndefined();
  });
});
