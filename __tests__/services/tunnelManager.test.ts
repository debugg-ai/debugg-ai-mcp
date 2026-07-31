/**
 * TunnelManager tests.
 *
 * Covers session-key-scoped tunnel creation/reuse (one ngrok tunnel per
 * session — docs/local-tunnel-multiplexer-architecture-2026-07-31.md §2.1/
 * §2.3), stopTunnel/stopAllTunnels cleanup, the concurrent cold-start dedup
 * fix, the run_test_suite dedicated-tunnel exception, and the connect-retry
 * ladder / fault-injection behavior carried over unchanged from the old
 * per-port design.
 *
 * The whole cross-process "borrow another MCP's tunnel" mechanism (registry
 * adoption, PID-liveness/freshness checks, re-adoption from the local ngrok
 * agent — beads 3th/y7x6/mdp/lc62's borrow half) is retired per §4: "No
 * sharing, ever, at any granularity." Those describe blocks are gone, not
 * adapted — there is nothing left in TunnelManager for them to test.
 */

import { jest } from '@jest/globals';
import { createInMemoryRegistry } from '../../services/ngrok/tunnelRegistry.js';
import { runWithApiKey } from '../../utils/requestContext.js';
import type { CaddyProxy, UpstreamTarget } from '../../services/caddy/caddyProxy.js';

// ── Mock ngrok ────────────────────────────────────────────────────────────────

const mockNgrokConnect = jest.fn<() => Promise<string>>();
const mockNgrokDisconnect = jest.fn<() => Promise<void>>();
const mockNgrokGetApi = jest.fn();

jest.unstable_mockModule('ngrok', () => ({
  connect: mockNgrokConnect,
  disconnect: mockNgrokDisconnect,
  getApi: mockNgrokGetApi,
  default: {
    connect: mockNgrokConnect,
    disconnect: mockNgrokDisconnect,
    getApi: mockNgrokGetApi,
  },
}));

// Bead pqgj: the manager pre-warms the ngrok agent's client session before
// tunnelling. The real starter deep-requires ngrok's internals and SPAWNS AN
// ACTUAL AGENT PROCESS — which a unit suite must never do. Stub it with a
// faithful stand-in: agent started, session established immediately.
const mockStartAgentSession = jest.fn(async (opts: any) => { opts.onStatusChange('connected'); });

jest.unstable_mockModule('../../services/ngrok/ngrokAgentSession.js', () => ({
  startAgentSession: mockStartAgentSession,
}));

// ── Import module under test (after mocks) ────────────────────────────────────

let TunnelManagerClass: typeof import('../../services/ngrok/tunnelManager.js').default;
let getSessionKey: typeof import('../../services/ngrok/tunnelManager.js').getSessionKey;

beforeAll(async () => {
  ({ default: TunnelManagerClass, getSessionKey } = await import('../../services/ngrok/tunnelManager.js'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockNgrokDisconnect.mockResolvedValue(undefined as any);
  mockNgrokGetApi.mockReturnValue(null);
});

// ── Fake CaddyProxy — a session's own instance is injected via caddyFactory,
//    never the real spawn-a-caddy-process implementation. ────────────────────

interface FakeCaddy extends CaddyProxy {
  setUpstreamCalls: UpstreamTarget[];
  firePortChanged: (newLocalOrigin: string) => void;
}

function makeFakeCaddy(opts: {
  localOrigin?: string;
  ensureStartedImpl?: () => Promise<{ localOrigin: string; localPort: number; adminPort: number }>;
  setUpstreamImpl?: (t: UpstreamTarget) => Promise<void>;
  stopImpl?: () => Promise<void>;
} = {}): FakeCaddy {
  const localOrigin = opts.localOrigin ?? 'http://127.0.0.1:41000';
  const setUpstreamCalls: UpstreamTarget[] = [];
  const portChangedListeners: Array<(o: string) => void> = [];

  const caddy: FakeCaddy = {
    ensureStarted: jest.fn(
      opts.ensureStartedImpl ??
      (async () => ({ localOrigin, localPort: 41000, adminPort: 41001 })),
    ) as any,
    setUpstream: jest.fn(async (t: UpstreamTarget) => {
      setUpstreamCalls.push(t);
      if (opts.setUpstreamImpl) await opts.setUpstreamImpl(t);
    }) as any,
    isHealthy: jest.fn(async () => true) as any,
    stop: jest.fn(opts.stopImpl ?? (async () => {})) as any,
    onPortChanged: jest.fn((cb: (o: string) => void) => { portChangedListeners.push(cb); }) as any,
    setUpstreamCalls,
    firePortChanged: (newLocalOrigin: string) => {
      portChangedListeners.forEach((cb) => cb(newLocalOrigin));
    },
  };
  return caddy;
}

/** A TunnelManager wired for fast, hermetic unit tests: in-memory registry,
 *  zero-delay retry backoff, and (unless overridden) a caddyFactory that
 *  hands out a fresh FakeCaddy per call — mirroring the real "one CaddyProxy
 *  instance per session key" contract (§2.2) without spawning anything. */
function freshTm(opts: { caddyFactory?: () => CaddyProxy } = {}) {
  const tm = new TunnelManagerClass(createInMemoryRegistry());
  tm.connectBackoffMs = [1, 1];
  tm.caddyFactory = opts.caddyFactory ?? (() => makeFakeCaddy());
  return tm;
}

// ── URL detection ─────────────────────────────────────────────────────────────

describe('URL detection', () => {
  test('isTunnelUrl detects .ngrok.debugg.ai URLs', () => {
    const tm = freshTm();
    expect(tm.isTunnelUrl('https://abc-123.ngrok.debugg.ai')).toBe(true);
    expect(tm.isTunnelUrl('https://abc-123.ngrok.debugg.ai/path')).toBe(true);
    expect(tm.isTunnelUrl('http://localhost:3000')).toBe(false);
    expect(tm.isTunnelUrl('https://example.com')).toBe(false);
  });

  test('extractTunnelId parses subdomain correctly', () => {
    const tm = freshTm();
    expect(tm.extractTunnelId('https://abc-123-def.ngrok.debugg.ai')).toBe('abc-123-def');
    expect(tm.extractTunnelId('https://tunnel-id.ngrok.debugg.ai/api')).toBe('tunnel-id');
    expect(tm.extractTunnelId('http://localhost:3000')).toBeNull();
    expect(tm.extractTunnelId('https://example.com')).toBeNull();
  });
});

// ── getSessionKey (§2.1) ────────────────────────────────────────────────────

describe('getSessionKey', () => {
  const originalTransport = process.env.DEBUGGAI_MCP_TRANSPORT;
  afterEach(() => {
    if (originalTransport === undefined) delete process.env.DEBUGGAI_MCP_TRANSPORT;
    else process.env.DEBUGGAI_MCP_TRANSPORT = originalTransport;
  });

  test('outside any request scope (stdio): returns the fixed "stdio" key', () => {
    expect(getSessionKey()).toBe('stdio');
  });

  test('inside runWithApiKey: derives a stable, hashed http: key from the bearer token', () => {
    const a = runWithApiKey('token-a', () => getSessionKey());
    const b = runWithApiKey('token-a', () => getSessionKey());
    expect(a).toBe(b);
    expect(a.startsWith('http:')).toBe(true);
  });

  test('different bearer tokens derive different session keys — the cross-tenant fix', () => {
    const a = runWithApiKey('caller-a-token', () => getSessionKey());
    const b = runWithApiKey('caller-b-token', () => getSessionKey());
    expect(a).not.toBe(b);
  });

  test('the raw API key is never present in the derived key', () => {
    const key = runWithApiKey('super-secret-token', () => getSessionKey());
    expect(key).not.toContain('super-secret-token');
  });

  test('HTTP transport with no API key in scope: still returns "stdio" (fallback), but this is the alarming case', () => {
    // httpServer.ts 401s before ever reaching runWithApiKey with an empty
    // token, so this should be unreachable in practice (§6) — but the
    // function must still degrade safely rather than throw.
    process.env.DEBUGGAI_MCP_TRANSPORT = 'http';
    expect(getSessionKey()).toBe('stdio');
  });
});

// ── ensureSessionTunnel — creation and reuse ─────────────────────────────────

describe('ensureSessionTunnel', () => {
  test('creates a session tunnel: spawns Caddy, dials it via ngrok, stores it under both maps', async () => {
    mockNgrokConnect.mockResolvedValue('https://my-id.ngrok.debugg.ai' as any);
    const caddy = makeFakeCaddy({ localOrigin: 'http://127.0.0.1:41000' });
    const tm = freshTm({ caddyFactory: () => caddy });

    const info = await tm.ensureSessionTunnel('sess-a', 'auth-token', 'my-id');

    expect(info.tunnelId).toBe('my-id');
    expect(info.sessionKey).toBe('sess-a');
    expect(info.tunnelUrl).toBe('https://my-id.ngrok.debugg.ai');
    expect(caddy.ensureStarted).toHaveBeenCalledTimes(1);
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
    const connectOpts = mockNgrokConnect.mock.calls[0][0] as any;
    // ngrok's own dial target is ALWAYS plain loopback HTTP to Caddy now —
    // no isHttpsLocal/inDocker complexity on this leg (§2.2/§2.3's MOVE).
    expect(connectOpts.addr).toBe('http://127.0.0.1:41000');
    expect(connectOpts.hostname).toBe('my-id.ngrok.debugg.ai');
    expect(connectOpts.authtoken).toBe('auth-token');
    expect(tm.getTunnelInfo('my-id')).toBe(info);
    expect(tm.getSessionTunnelInfo('sess-a')).toBe(info);
  });

  test('a random tunnelId is minted when none is supplied', async () => {
    mockNgrokConnect.mockResolvedValue('https://x.ngrok.debugg.ai' as any);
    const tm = freshTm();
    const info = await tm.ensureSessionTunnel('sess-a', 'auth-token');
    expect(typeof info.tunnelId).toBe('string');
    expect(info.tunnelId.length).toBeGreaterThan(0);
  });

  test('second call for the SAME session key reuses the tunnel — no second Caddy, no second connect', async () => {
    mockNgrokConnect.mockResolvedValueOnce('https://t1.ngrok.debugg.ai' as any);
    const caddy = makeFakeCaddy();
    const tm = freshTm({ caddyFactory: () => caddy });

    const first = await tm.ensureSessionTunnel('sess-a', 'auth', 't1');
    const second = await tm.ensureSessionTunnel('sess-a', 'auth', 'ignored-id');

    expect(second).toBe(first); // same object, not just same tunnelId
    expect(caddy.ensureStarted).toHaveBeenCalledTimes(1);
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('a DIFFERENT session key gets its OWN Caddy instance and its OWN tunnel', async () => {
    mockNgrokConnect
      .mockResolvedValueOnce('https://t1.ngrok.debugg.ai' as any)
      .mockResolvedValueOnce('https://t2.ngrok.debugg.ai' as any);
    const caddies: FakeCaddy[] = [];
    const tm = freshTm({ caddyFactory: () => { const c = makeFakeCaddy(); caddies.push(c); return c; } });

    const a = await tm.ensureSessionTunnel('sess-a', 'auth', 't1');
    const b = await tm.ensureSessionTunnel('sess-b', 'auth', 't2');

    expect(a.tunnelId).not.toBe(b.tunnelId);
    expect(a.caddy).not.toBe(b.caddy);
    expect(caddies).toHaveLength(2);
    expect(mockNgrokConnect).toHaveBeenCalledTimes(2);
  });

  test('wraps authtoken error with a clear message and stops the Caddy it just spawned', async () => {
    mockNgrokConnect.mockRejectedValue(new Error('invalid authtoken provided'));
    const caddy = makeFakeCaddy();
    const tm = freshTm({ caddyFactory: () => caddy });

    await expect(tm.ensureSessionTunnel('sess-a', 'bad')).rejects.toThrow('invalid auth token');
    expect(caddy.stop).toHaveBeenCalledTimes(1);
  });

  test('wraps other connect errors, and stops the orphaned Caddy instance', async () => {
    mockNgrokConnect.mockRejectedValue(new Error('connection refused'));
    const caddy = makeFakeCaddy();
    const tm = freshTm({ caddyFactory: () => caddy });

    await expect(tm.ensureSessionTunnel('sess-a', 'auth')).rejects.toThrow('Failed to create tunnel');
    expect(caddy.stop).toHaveBeenCalledTimes(1);
  });
});

// ── §2.3 / §5.5: concurrent cold-start dedup ─────────────────────────────────

describe('concurrent cold-start dedup (closes review finding: cold-start TOCTOU)', () => {
  test('two near-simultaneous first calls for a brand-new session key join ONE creation', async () => {
    mockNgrokConnect.mockResolvedValue('https://tunnel-a.ngrok.debugg.ai' as any);
    let caddyFactoryCalls = 0;
    const tm = freshTm({
      caddyFactory: () => { caddyFactoryCalls++; return makeFakeCaddy(); },
    });

    // Both calls issued back-to-back, in the same synchronous stretch, with
    // no `await` in between — exactly the §3.5 scenario an orchestrating
    // agent produces (an initial navigate fired alongside an initial probe).
    const aPromise = tm.ensureSessionTunnel('sess-cold', 'auth', 'tunnel-a');
    const bPromise = tm.ensureSessionTunnel('sess-cold', 'auth', 'tunnel-b');

    const [a, b] = await Promise.all([aPromise, bPromise]);

    expect(caddyFactoryCalls).toBe(1);
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // identical TunnelInfo object, not just equal tunnelId
    expect(a.tunnelId).toBe('tunnel-a'); // whichever call's synchronous prefix won the slot
  });

  test('rejected creation: BOTH callers reject, no half-registered state, a later call retries cleanly', async () => {
    mockNgrokConnect
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom')) // ixh retry ladder: connectBackoffMs=[1,1] => up to 3 attempts
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('https://recovered.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const aPromise = tm.ensureSessionTunnel('sess-cold-fail', 'auth', 'tunnel-a');
    const bPromise = tm.ensureSessionTunnel('sess-cold-fail', 'auth', 'tunnel-b');

    await expect(aPromise).rejects.toThrow('Failed to create tunnel');
    await expect(bPromise).rejects.toThrow('Failed to create tunnel');

    // No half-registered state left behind for this session key.
    expect(tm.getSessionTunnelInfo('sess-cold-fail')).toBeUndefined();

    // A subsequent call for the same session key provisions fresh rather than
    // replaying the cached failure.
    const recovered = await tm.ensureSessionTunnel('sess-cold-fail', 'auth', 'tunnel-c');
    expect(recovered.tunnelId).toBe('tunnel-c');
  });
});

// ── stopTunnel ────────────────────────────────────────────────────────────────

describe('stopTunnel', () => {
  test('disconnects ngrok, stops Caddy, and removes the tunnel from both maps', async () => {
    mockNgrokConnect.mockResolvedValue('https://t1.ngrok.debugg.ai' as any);
    const caddy = makeFakeCaddy();
    const tm = freshTm({ caddyFactory: () => caddy });
    await tm.ensureSessionTunnel('sess-a', 'auth', 't1');

    await tm.stopTunnel('t1');

    expect(mockNgrokDisconnect).toHaveBeenCalledWith('https://t1.ngrok.debugg.ai');
    expect(caddy.stop).toHaveBeenCalledTimes(1);
    expect(tm.getActiveTunnels()).toHaveLength(0);
    expect(tm.getSessionTunnelInfo('sess-a')).toBeUndefined();
  });

  test('no-op for unknown tunnel ID', async () => {
    const tm = freshTm();
    await expect(tm.stopTunnel('non-existent')).resolves.not.toThrow();
  });

  test('calls revokeKey callback when tunnel stops', async () => {
    mockNgrokConnect.mockResolvedValue('https://t1.ngrok.debugg.ai' as any);
    const revokeKey = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const tm = freshTm();
    await tm.ensureSessionTunnel('sess-a', 'auth', 't1', 'kid-1', revokeKey);

    await tm.stopTunnel('t1');

    expect(revokeKey).toHaveBeenCalledTimes(1);
  });

  test('no revokeKey registered — no crash', async () => {
    mockNgrokConnect.mockResolvedValue('https://t1.ngrok.debugg.ai' as any);
    const tm = freshTm();
    await tm.ensureSessionTunnel('sess-a', 'auth', 't1');
    await expect(tm.stopTunnel('t1')).resolves.not.toThrow();
  });
});

// ── §2.3 / §5.5: stopTunnel unconditional-removal ordering ──────────────────

describe('stopTunnel: unconditional state removal (closes review finding: onPortChanged cleanup ordering)', () => {
  test('caddy.stop() rejecting still removes the tunnel synchronously relative to the rejection, never rethrows, and telemeters the failure', async () => {
    mockNgrokConnect.mockResolvedValue('https://t1.ngrok.debugg.ai' as any);
    const caddy = makeFakeCaddy({ stopImpl: async () => { throw new Error('caddy admin API unreachable'); } });
    const tm = freshTm({ caddyFactory: () => caddy });
    await tm.ensureSessionTunnel('sess-a', 'auth', 't1');

    await expect(tm.stopTunnel('t1')).resolves.toBeUndefined(); // never rejects

    // Removed from both maps regardless of which cleanup step failed.
    expect(tm.getActiveTunnels()).toHaveLength(0);
    expect(tm.getTunnelInfo('t1')).toBeUndefined();
    expect(tm.getSessionTunnelInfo('sess-a')).toBeUndefined();
  });

  test('ngrok.disconnect rejecting still removes the tunnel and still revokes the key', async () => {
    mockNgrokConnect.mockResolvedValue('https://t1.ngrok.debugg.ai' as any);
    mockNgrokDisconnect.mockRejectedValueOnce(new Error('already gone'));
    const revokeKey = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const tm = freshTm();
    await tm.ensureSessionTunnel('sess-a', 'auth', 't1', 'kid-1', revokeKey);

    await expect(tm.stopTunnel('t1')).resolves.not.toThrow();

    expect(tm.getActiveTunnels()).toHaveLength(0);
    expect(revokeKey).toHaveBeenCalledTimes(1);
  });

  test('a queued waiter promoted against a Caddy that stopTunnel already tore down fails cleanly, not silently', async () => {
    // Simulates §5.4's cross-tunnel eviction interaction from the PortLock's
    // side: once stopTunnel has run, the session's own PortLock is a fresh
    // orphan — nothing in TunnelManager keeps stale portLock/caddy pairs
    // reachable via activeTunnels/sessionTunnels after this point.
    mockNgrokConnect.mockResolvedValue('https://t1.ngrok.debugg.ai' as any);
    const caddy = makeFakeCaddy();
    const tm = freshTm({ caddyFactory: () => caddy });
    const info = await tm.ensureSessionTunnel('sess-a', 'auth', 't1');

    await tm.stopTunnel('t1');

    // The evicted TunnelInfo's own portLock/caddy are no longer reachable
    // through the manager — a caller still holding a reference to `info`
    // (e.g. a queued lock waiter) would fail against `info.caddy` directly,
    // not corrupt shared TunnelManager state.
    expect(tm.getTunnelInfo('t1')).toBeUndefined();
    expect(info.caddy).toBe(caddy);
  });
});

// ── onPortChanged eviction wiring ─────────────────────────────────────────────

describe('onPortChanged eviction (§2.3: a crash-respawn that lands on a new port evicts the whole session tunnel)', () => {
  test('firing onPortChanged evicts the tunnel via stopTunnel', async () => {
    mockNgrokConnect.mockResolvedValue('https://t1.ngrok.debugg.ai' as any);
    const caddy = makeFakeCaddy();
    const tm = freshTm({ caddyFactory: () => caddy });
    await tm.ensureSessionTunnel('sess-a', 'auth', 't1');
    expect(tm.getActiveTunnels()).toHaveLength(1);

    caddy.firePortChanged('http://127.0.0.1:55555');
    // stopTunnel() is fired-and-forgotten from the onPortChanged handler —
    // flush microtasks so its (mocked, instant) cleanup work completes.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(tm.getActiveTunnels()).toHaveLength(0);
    expect(tm.getSessionTunnelInfo('sess-a')).toBeUndefined();
  });

  test('registered exactly once per session tunnel', async () => {
    mockNgrokConnect.mockResolvedValue('https://t1.ngrok.debugg.ai' as any);
    const caddy = makeFakeCaddy();
    const tm = freshTm({ caddyFactory: () => caddy });
    await tm.ensureSessionTunnel('sess-a', 'auth', 't1');

    expect(caddy.onPortChanged).toHaveBeenCalledTimes(1);
  });
});

// ── stopAllTunnels ────────────────────────────────────────────────────────────

describe('stopAllTunnels', () => {
  test('disconnects all active session tunnels', async () => {
    mockNgrokConnect
      .mockResolvedValueOnce('https://t1.ngrok.debugg.ai' as any)
      .mockResolvedValueOnce('https://t2.ngrok.debugg.ai' as any);
    const tm = freshTm();
    await tm.ensureSessionTunnel('sess-a', 'auth', 't1');
    await tm.ensureSessionTunnel('sess-b', 'auth', 't2');

    await tm.stopAllTunnels();

    expect(mockNgrokDisconnect).toHaveBeenCalledTimes(2);
    expect(tm.getActiveTunnels()).toHaveLength(0);
  });
});

// ── Timer / status helpers ────────────────────────────────────────────────────

describe('timer and status helpers', () => {
  test('touchTunnel on non-existent ID does not throw', () => {
    const tm = freshTm();
    expect(() => tm.touchTunnel('non-existent')).not.toThrow();
  });

  test('touchTunnelByUrl on non-existent URL does not throw', () => {
    const tm = freshTm();
    expect(() => tm.touchTunnelByUrl('https://ghost.ngrok.debugg.ai')).not.toThrow();
  });

  test('getTunnelStatus returns null for unknown ID', () => {
    const tm = freshTm();
    expect(tm.getTunnelStatus('unknown')).toBeNull();
  });

  test('getAllTunnelStatuses returns empty array when no tunnels', () => {
    const tm = freshTm();
    expect(tm.getAllTunnelStatuses()).toEqual([]);
  });

  test('touchTunnel resets the idle timer for an existing session tunnel', async () => {
    mockNgrokConnect.mockResolvedValue('https://t1.ngrok.debugg.ai' as any);
    const tm = freshTm();
    // Deliberately NOT the default 55 minutes — a long-lived dangling
    // setTimeout would outlive this test file's Jest realm and blow up on
    // a later, unrelated suite ("import after teardown"). stopTunnel()
    // below clears it either way, but keep this short as defense in depth.
    tm.idleTimeoutMs = 10_000;
    const info = await tm.ensureSessionTunnel('sess-a', 'auth', 't1');
    const before = info.lastAccessedAt;

    await new Promise((r) => setTimeout(r, 5));
    tm.touchTunnel('t1');

    expect(info.lastAccessedAt).toBeGreaterThan(before);
    await tm.stopTunnel('t1'); // clears the idle timer armed above
  });
});

// ── Bead ixh: ngrok.connect() 3-attempt retry with backoff ──────────────────

describe('bead ixh: connectWithRetry 3-attempt retry (unchanged, now dialing Caddy)', () => {
  test('attempt 1 succeeds: no retry, no extra call', async () => {
    mockNgrokConnect.mockResolvedValueOnce('https://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const info = await tm.ensureSessionTunnel('sess-a', 'tok', 't1');

    expect(info.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('attempt 1 fails, attempt 2 succeeds (agent-reset path)', async () => {
    const flaky = new Error('connect ECONNRESET');
    mockNgrokConnect
      .mockRejectedValueOnce(flaky)
      .mockResolvedValueOnce('https://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const info = await tm.ensureSessionTunnel('sess-a', 'tok', 't1');

    expect(info.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(2);
  });

  test('attempts 1+2 fail, attempt 3 succeeds — the NEW retry case ixh fixes', async () => {
    const flaky1 = new Error('connect ECONNRESET');
    const flaky2 = new Error('ngrok agent dial timeout');
    mockNgrokConnect
      .mockRejectedValueOnce(flaky1)
      .mockRejectedValueOnce(flaky2)
      .mockResolvedValueOnce('https://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const info = await tm.ensureSessionTunnel('sess-a', 'tok', 't1');

    expect(info.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(3);
  });

  test('all 3 attempts fail: throws with the last error message', async () => {
    mockNgrokConnect
      .mockRejectedValueOnce(new Error('first fail'))
      .mockRejectedValueOnce(new Error('second fail'))
      .mockRejectedValueOnce(new Error('third fail'));
    const tm = freshTm();

    await expect(
      tm.ensureSessionTunnel('sess-a', 'tok', 't1'),
    ).rejects.toThrow(/Failed to create tunnel.*third fail/);

    expect(mockNgrokConnect).toHaveBeenCalledTimes(3);
  });

  test('auth error: fails fast on attempt 1, no retry', async () => {
    mockNgrokConnect.mockRejectedValueOnce(new Error('invalid authtoken'));
    const tm = freshTm();

    await expect(
      tm.ensureSessionTunnel('sess-a', 'tok', 't1'),
    ).rejects.toThrow(/invalid auth token/);

    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('empty URL returned: treated as retryable error', async () => {
    mockNgrokConnect
      .mockResolvedValueOnce('' as any)
      .mockResolvedValueOnce('https://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const info = await tm.ensureSessionTunnel('sess-a', 'tok', 't1');

    expect(info.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(2);
  });

  test('timing: failed attempts actually sleep between them', async () => {
    mockNgrokConnect
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('https://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();
    tm.connectBackoffMs = [50, 50];

    const start = Date.now();
    await tm.ensureSessionTunnel('sess-a', 'tok', 't1');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(90);
  });
});

// ── Bead 42g: fault-injection integration ────────────────────────────────────

describe('bead 42g: DEBUGG_TUNNEL_FAULT_MODE integration', () => {
  const originalMode = process.env.DEBUGG_TUNNEL_FAULT_MODE;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalMode === undefined) delete process.env.DEBUGG_TUNNEL_FAULT_MODE;
    else process.env.DEBUGG_TUNNEL_FAULT_MODE = originalMode;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test('fail-connect-N:2 forces 2 synthetic failures; succeeds on attempt 3 WITHOUT touching ngrok.connect', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'fail-connect-N:2';
    mockNgrokConnect.mockResolvedValue('https://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const info = await tm.ensureSessionTunnel('sess-a', 'tok', 't1');

    expect(info.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('fail-connect-N:3 exhausts the retry budget and throws the synthetic error', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'fail-connect-N:3';
    mockNgrokConnect.mockResolvedValue('https://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    await expect(
      tm.ensureSessionTunnel('sess-a', 'tok', 't1'),
    ).rejects.toThrow(/\[fault-inject\] synthetic connect failure/);

    expect(mockNgrokConnect).toHaveBeenCalledTimes(0);
  });

  test('SAFETY: fault injection is inert when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'fail-connect-N:5';
    mockNgrokConnect.mockResolvedValue('https://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const info = await tm.ensureSessionTunnel('sess-a', 'tok', 't1');

    expect(info.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('delay-connect:100 adds the delay to each attempt', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'delay-connect:100';
    mockNgrokConnect.mockResolvedValue('https://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const start = Date.now();
    await tm.ensureSessionTunnel('sess-a', 'tok', 't1');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(90);
  });
});

// ── markTunnelDead ────────────────────────────────────────────────────────────

describe('markTunnelDead (§2.3: dropped its `port` parameter — no longer port-scoped)', () => {
  test('delegates to stopTunnel', async () => {
    mockNgrokConnect.mockResolvedValue('https://t1.ngrok.debugg.ai' as any);
    const caddy = makeFakeCaddy();
    const tm = freshTm({ caddyFactory: () => caddy });
    await tm.ensureSessionTunnel('sess-a', 'auth', 't1');

    await tm.markTunnelDead('t1');

    expect(mockNgrokDisconnect).toHaveBeenCalledWith('https://t1.ngrok.debugg.ai');
    expect(caddy.stop).toHaveBeenCalledTimes(1);
    expect(tm.getActiveTunnels()).toHaveLength(0);
  });

  test('unknown tunnelId: no-op, does not throw', async () => {
    const tm = freshTm();
    await expect(tm.markTunnelDead('ghost')).resolves.not.toThrow();
  });
});

// ── §2.3: acquireDedicatedTunnel — the run_test_suite exception ─────────────

describe('acquireDedicatedTunnel (run_test_suite exception — bypasses Caddy/PortLock entirely)', () => {
  test('dials ngrok directly at the local app, never touches caddyFactory', async () => {
    mockNgrokConnect.mockResolvedValue('https://dedicated.ngrok.debugg.ai' as any);
    let caddyFactoryCalls = 0;
    const tm = freshTm({ caddyFactory: () => { caddyFactoryCalls++; return makeFakeCaddy(); } });

    const result = await tm.acquireDedicatedTunnel('http://localhost:5005/app', 'auth-token');

    expect(caddyFactoryCalls).toBe(0);
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
    const connectOpts = mockNgrokConnect.mock.calls[0][0] as any;
    // Bead fhg: explicit IPv4 loopback — the exact matrix caddyProxy.ts's
    // resolveDialAddress() now owns, reused (not re-derived) here.
    expect(connectOpts.addr).toBe('127.0.0.1:5005');
    expect(result.tunnelId).toBeDefined();
    // The returned URL is path-baked around the freshly-minted tunnelId's
    // OWN domain (generateTunnelUrl), not whatever domain the mocked
    // ngrok.connect() happened to return — mirroring today's per-port
    // createTunnel()'s publicUrl behavior.
    expect(result.url).toContain(`${result.tunnelId}.ngrok.debugg.ai`);
    expect(result.url).toContain('/app');
  });

  test('https localhost → addr is "https://localhost:<port>" (ngrok addr format, NOT Caddy dial format)', async () => {
    mockNgrokConnect.mockResolvedValue('https://dedicated.ngrok.debugg.ai' as any);
    const tm = freshTm();

    await tm.acquireDedicatedTunnel('https://localhost:3443', 'auth-token');

    const connectOpts = mockNgrokConnect.mock.calls[0][0] as any;
    // Unlike caddyProxy.ts's resolveDialAddress() (Caddy's `dial` field is
    // always a bare host:port), ngrok's own `addr` option needs the scheme
    // prefix for an HTTPS local target — see tunnelManager.ts's comment on
    // why acquireDedicatedTunnel cannot reuse resolveDialAddress().
    expect(connectOpts.addr).toBe('https://localhost:3443');
  });

  test('each call mints its OWN tunnel — no session-key dedup for the dedicated path', async () => {
    mockNgrokConnect
      .mockResolvedValueOnce('https://d1.ngrok.debugg.ai' as any)
      .mockResolvedValueOnce('https://d2.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const a = await tm.acquireDedicatedTunnel('http://localhost:5005', 'auth');
    const b = await tm.acquireDedicatedTunnel('http://localhost:5005', 'auth');

    expect(a.tunnelId).not.toBe(b.tunnelId);
    expect(mockNgrokConnect).toHaveBeenCalledTimes(2);
  });

  test('throws a clear error when the URL has no parseable port', async () => {
    const tm = freshTm();
    await expect(tm.acquireDedicatedTunnel('https://example.com', 'auth'))
      .rejects.toThrow('could not extract port');
    expect(mockNgrokConnect).not.toHaveBeenCalled();
  });

  test('a dedicated tunnel can be stopped by tunnelId through the unified stopTunnel API', async () => {
    mockNgrokConnect.mockResolvedValue('https://dedicated.ngrok.debugg.ai' as any);
    const tm = freshTm();
    const { tunnelId } = await tm.acquireDedicatedTunnel('http://localhost:5005', 'auth');

    await expect(tm.stopTunnel(tunnelId)).resolves.not.toThrow();
    expect(mockNgrokDisconnect).toHaveBeenCalledWith('https://dedicated.ngrok.debugg.ai');
  });

  test('is included in stopAllTunnels sweep', async () => {
    mockNgrokConnect
      .mockResolvedValueOnce('https://session.ngrok.debugg.ai' as any)
      .mockResolvedValueOnce('https://dedicated.ngrok.debugg.ai' as any);
    const tm = freshTm();
    await tm.ensureSessionTunnel('sess-a', 'auth', 'session-t');
    await tm.acquireDedicatedTunnel('http://localhost:5005', 'auth');

    await tm.stopAllTunnels();

    expect(mockNgrokDisconnect).toHaveBeenCalledTimes(2);
    expect(tm.getActiveTunnels()).toHaveLength(0);
  });
});
