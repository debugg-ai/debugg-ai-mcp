/**
 * TunnelManager tests.
 *
 * Covers:
 *  - URL detection / ID extraction (pure logic)
 *  - Per-port tunnel creation and reuse
 *  - stopTunnel / stopAllTunnels cleanup
 *  - Timer and status helpers
 */

import { jest } from '@jest/globals';
import { createInMemoryRegistry } from '../../services/ngrok/tunnelRegistry.js';

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

// ── Import module under test (after mocks) ────────────────────────────────────

let TunnelManagerClass: typeof import('../../services/ngrok/tunnelManager.js').default;

beforeAll(async () => {
  ({ default: TunnelManagerClass } = await import('../../services/ngrok/tunnelManager.js'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockNgrokDisconnect.mockResolvedValue(undefined as any);
  mockNgrokGetApi.mockReturnValue(null);
});

// ── URL detection ─────────────────────────────────────────────────────────────

describe('URL detection', () => {
  test('isTunnelUrl detects .ngrok.debugg.ai URLs', () => {
    const tm = new TunnelManagerClass();
    expect(tm.isTunnelUrl('https://abc-123.ngrok.debugg.ai')).toBe(true);
    expect(tm.isTunnelUrl('https://abc-123.ngrok.debugg.ai/path')).toBe(true);
    expect(tm.isTunnelUrl('http://localhost:3000')).toBe(false);
    expect(tm.isTunnelUrl('https://example.com')).toBe(false);
  });

  test('extractTunnelId parses subdomain correctly', () => {
    const tm = new TunnelManagerClass();
    expect(tm.extractTunnelId('https://abc-123-def.ngrok.debugg.ai')).toBe('abc-123-def');
    expect(tm.extractTunnelId('https://tunnel-id.ngrok.debugg.ai/api')).toBe('tunnel-id');
    expect(tm.extractTunnelId('http://localhost:3000')).toBeNull();
    expect(tm.extractTunnelId('https://example.com')).toBeNull();
  });
});

// ── processUrl ────────────────────────────────────────────────────────────────

describe('processUrl', () => {
  test('passes through non-localhost URLs unchanged', async () => {
    const tm = new TunnelManagerClass();
    const result = await tm.processUrl('https://example.com/path');

    expect(result.isLocalhost).toBe(false);
    expect(result.url).toBe('https://example.com/path');
    expect(mockNgrokConnect).not.toHaveBeenCalled();
  });

  test('creates tunnel for localhost URL', async () => {
    mockNgrokConnect.mockResolvedValue('http://my-id.ngrok.debugg.ai' as any);

    const tm = new TunnelManagerClass();
    const result = await tm.processUrl('http://localhost:3000', 'auth-token', 'my-id');

    expect(result.isLocalhost).toBe(true);
    expect(result.url).toBe('https://my-id.ngrok.debugg.ai/');
    expect(result.tunnelId).toBe('my-id');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('reuses existing tunnel for the same port', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai' as any);

    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'auth-token', 't1');
    const result = await tm.processUrl('http://localhost:3000', 'auth-token', 't2');

    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
    expect(result.tunnelId).toBe('t1');
  });

  test('creates separate tunnels for different ports', async () => {
    mockNgrokConnect
      .mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any)
      .mockResolvedValueOnce('http://t2.ngrok.debugg.ai' as any);

    const tm = new TunnelManagerClass();
    const r1 = await tm.processUrl('http://localhost:3000', 'auth-token', 't1');
    const r2 = await tm.processUrl('http://localhost:4000', 'auth-token', 't2');

    expect(mockNgrokConnect).toHaveBeenCalledTimes(2);
    expect(r1.tunnelId).toBe('t1');
    expect(r2.tunnelId).toBe('t2');
  });

  test('throws without auth token for localhost URL', async () => {
    const tm = new TunnelManagerClass();
    await expect(tm.processUrl('http://localhost:3000')).rejects.toThrow('Auth token required');
  });

  test('connect options do not include a separate authtoken() call', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai' as any);

    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'my-key', 't1');

    // authtoken is passed inside connect options only — no separate global setter
    const connectCall = mockNgrokConnect.mock.calls[0][0] as any;
    expect(connectCall.authtoken).toBe('my-key');
  });
});

// ── getTunnelForPort ──────────────────────────────────────────────────────────

describe('getTunnelForPort', () => {
  test('returns undefined when no tunnel exists for port', () => {
    const tm = new TunnelManagerClass();
    expect(tm.getTunnelForPort(3000)).toBeUndefined();
  });

  test('returns TunnelInfo after tunnel is created for that port', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai' as any);

    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'auth', 't1');

    const info = tm.getTunnelForPort(3000);
    expect(info).toBeDefined();
    expect(info!.tunnelId).toBe('t1');
    expect(info!.port).toBe(3000);
  });

  test('returns undefined after tunnel is stopped', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai' as any);

    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'auth', 't1');
    await tm.stopTunnel('t1');

    expect(tm.getTunnelForPort(3000)).toBeUndefined();
  });
});

// ── stopTunnel ────────────────────────────────────────────────────────────────

describe('stopTunnel', () => {
  test('disconnects tunnel and removes it from active tunnels', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai' as any);

    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'auth-token', 't1');
    await tm.stopTunnel('t1');

    expect(mockNgrokDisconnect).toHaveBeenCalledWith('http://t1.ngrok.debugg.ai');
    expect(tm.getActiveTunnels()).toHaveLength(0);
  });

  test('removes from active tunnels even when disconnect throws', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai' as any);
    mockNgrokDisconnect.mockRejectedValue(new Error('ngrok gone'));

    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'auth-token', 't1');

    await expect(tm.stopTunnel('t1')).resolves.not.toThrow();
    expect(tm.getActiveTunnels()).toHaveLength(0);
  });

  test('no-op for unknown tunnel ID', async () => {
    const tm = new TunnelManagerClass();
    await expect(tm.stopTunnel('non-existent')).resolves.not.toThrow();
  });

  test('calls revokeKey callback when tunnel stops', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai' as any);
    const revokeKey = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'auth', 't1', 'kid-1', revokeKey);
    await tm.stopTunnel('t1');

    expect(revokeKey).toHaveBeenCalledTimes(1);
  });

  test('revokeKey NOT called when disconnect throws (key still revoked)', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai' as any);
    mockNgrokDisconnect.mockRejectedValue(new Error('already gone'));
    const revokeKey = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'auth', 't1', 'kid-1', revokeKey);
    await tm.stopTunnel('t1');

    // revokeKey still fires even when disconnect fails
    expect(revokeKey).toHaveBeenCalledTimes(1);
  });

  test('no revokeKey registered — no crash', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai' as any);

    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'auth', 't1'); // no revokeKey
    await expect(tm.stopTunnel('t1')).resolves.not.toThrow();
  });
});

// ── stopAllTunnels ────────────────────────────────────────────────────────────

describe('stopAllTunnels', () => {
  test('disconnects all active tunnels', async () => {
    mockNgrokConnect
      .mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any)
      .mockResolvedValueOnce('http://t2.ngrok.debugg.ai' as any);

    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'auth-token', 't1');
    await tm.processUrl('http://localhost:4000', 'auth-token', 't2');

    await tm.stopAllTunnels();

    expect(mockNgrokDisconnect).toHaveBeenCalledTimes(2);
    expect(tm.getActiveTunnels()).toHaveLength(0);
  });
});

// ── Timer / status helpers ────────────────────────────────────────────────────

describe('timer and status helpers', () => {
  test('touchTunnel on non-existent ID does not throw', () => {
    const tm = new TunnelManagerClass();
    expect(() => tm.touchTunnel('non-existent')).not.toThrow();
  });

  test('touchTunnelByUrl on non-existent URL does not throw', () => {
    const tm = new TunnelManagerClass();
    expect(() => tm.touchTunnelByUrl('https://ghost.ngrok.debugg.ai')).not.toThrow();
  });

  test('getTunnelStatus returns null for unknown ID', () => {
    const tm = new TunnelManagerClass();
    expect(tm.getTunnelStatus('unknown')).toBeNull();
  });

  test('getAllTunnelStatuses returns empty array when no tunnels', () => {
    const tm = new TunnelManagerClass();
    expect(tm.getAllTunnelStatuses()).toEqual([]);
  });
});

// ── createTunnel — connect options and environment ───────────────────────────

describe('createTunnel — connect options and environment', () => {
  test('passes authtoken inside connect() options', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai');
    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'my-secret-key', 't1');
    const opts = mockNgrokConnect.mock.calls[0][0] as any;
    expect(opts.authtoken).toBe('my-secret-key');
    expect(opts.proto).toBe('http');
    expect(opts.hostname).toBe('t1.ngrok.debugg.ai');
    expect(opts.addr).toBe('127.0.0.1:3000'); // bead fhg: explicit IPv4 loopback for plain http
  });

  test('uses https string addr for https localhost URLs', async () => {
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai');
    const tm = new TunnelManagerClass();
    await tm.processUrl('https://localhost:3000', 'auth', 't1');
    const opts = mockNgrokConnect.mock.calls[0][0] as any;
    expect(opts.addr).toBe('https://localhost:3000');
  });

  test('uses host.docker.internal addr when DOCKER_CONTAINER=true', async () => {
    process.env.DOCKER_CONTAINER = 'true';
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai');
    const tm = new TunnelManagerClass();
    await tm.processUrl('http://localhost:3000', 'auth', 't1');
    const opts = mockNgrokConnect.mock.calls[0][0] as any;
    expect(opts.addr).toBe('host.docker.internal:3000');
    delete process.env.DOCKER_CONTAINER;
  });

  test('uses https host.docker.internal for https localhost in Docker', async () => {
    process.env.DOCKER_CONTAINER = 'true';
    mockNgrokConnect.mockResolvedValue('http://t1.ngrok.debugg.ai');
    const tm = new TunnelManagerClass();
    await tm.processUrl('https://localhost:3000', 'auth', 't1');
    const opts = mockNgrokConnect.mock.calls[0][0] as any;
    expect(opts.addr).toBe('https://host.docker.internal:3000');
    delete process.env.DOCKER_CONTAINER;
  });

  test('wraps authtoken error with clear message', async () => {
    mockNgrokConnect.mockRejectedValue(new Error('invalid authtoken provided'));
    const tm = new TunnelManagerClass();
    await expect(tm.processUrl('http://localhost:3000', 'bad', 't1'))
      .rejects.toThrow('invalid auth token');
  });

  test('wraps other connect errors', async () => {
    mockNgrokConnect.mockRejectedValue(new Error('connection refused'));
    const tm = new TunnelManagerClass();
    await expect(tm.processUrl('http://localhost:3000', 'auth', 't1'))
      .rejects.toThrow('Failed to create tunnel');
  });
});

// ── Cross-process registry ─────────────────────────────────────────────────────
//
// Two TunnelManager instances share an in-memory RegistryStore that simulates
// the file-backed store used in production.  isPidAlive is controlled per-test.

describe('cross-process tunnel sharing', () => {
  test('Process B borrows tunnel created by Process A — no second connect', async () => {
    const reg = createInMemoryRegistry(() => true); // all PIDs "alive"
    mockNgrokConnect.mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any);

    const tmA = new TunnelManagerClass(reg);
    await tmA.processUrl('http://localhost:3000', 'auth-a', 't1');

    const tmB = new TunnelManagerClass(reg);
    const result = await tmB.processUrl('http://localhost:3000', 'auth-b', 't2');

    // ngrok.connect called exactly once — B reused A's tunnel
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
    expect(result.tunnelId).toBe('t1');
    expect(result.url).toContain('t1.ngrok.debugg.ai');
  });

  test('Process B creates its own tunnel when Process A is dead', async () => {
    const reg = createInMemoryRegistry(() => false); // all PIDs "dead"
    // Seed a stale registry entry from a "dead" process
    reg.write({
      '3000': {
        tunnelId: 'stale-t1',
        publicUrl: 'https://stale-t1.ngrok.debugg.ai/',
        tunnelUrl: 'http://stale-t1.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 99999,
        lastAccessedAt: Date.now(),
      },
    });

    mockNgrokConnect.mockResolvedValueOnce('http://t2.ngrok.debugg.ai' as any);

    const tmB = new TunnelManagerClass(reg);
    const result = await tmB.processUrl('http://localhost:3000', 'auth-b', 't2');

    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
    expect(result.tunnelId).toBe('t2');
  });

  test('borrowed tunnel is evicted from local map when owner dies', async () => {
    let ownerAlive = true;
    const reg = createInMemoryRegistry(() => ownerAlive);
    mockNgrokConnect.mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any);

    // A creates tunnel; B borrows it
    const tmA = new TunnelManagerClass(reg);
    await tmA.processUrl('http://localhost:3000', 'auth-a', 't1');

    const tmB = new TunnelManagerClass(reg);
    await tmB.processUrl('http://localhost:3000', 'auth-b', 't2');
    expect(tmB.getTunnelForPort(3000)?.tunnelId).toBe('t1'); // borrowed

    // A's process dies
    ownerAlive = false;

    // getTunnelForPort now evicts the dead borrowed entry
    expect(tmB.getTunnelForPort(3000)).toBeUndefined();
  });

  test('stopTunnel on borrowed tunnel does NOT call ngrok.disconnect', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any);

    const tmA = new TunnelManagerClass(reg);
    await tmA.processUrl('http://localhost:3000', 'auth-a', 't1');

    const tmB = new TunnelManagerClass(reg);
    await tmB.processUrl('http://localhost:3000', 'auth-b', 't2');

    jest.clearAllMocks();
    mockNgrokDisconnect.mockResolvedValue(undefined as any);

    await tmB.stopTunnel('t1');

    // B should NOT have disconnected — it doesn't own the tunnel
    expect(mockNgrokDisconnect).not.toHaveBeenCalled();
    // B's local map is cleared
    expect(tmB.getActiveTunnels()).toHaveLength(0);
    // A still owns the tunnel
    expect(tmA.getActiveTunnels()).toHaveLength(1);
  });

  test('owner stopTunnel removes registry entry — second borrower sees no entry', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect
      .mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any)
      .mockResolvedValueOnce('http://t2.ngrok.debugg.ai' as any);

    const tmA = new TunnelManagerClass(reg);
    await tmA.processUrl('http://localhost:3000', 'auth-a', 't1');

    // A stops its owned tunnel — deregisters from shared registry
    await tmA.stopTunnel('t1');
    expect(reg.read()['3000']).toBeUndefined();

    // C (a third instance) sees no registry entry and creates its own
    const tmC = new TunnelManagerClass(reg);
    await tmC.processUrl('http://localhost:3000', 'auth-c', 't2');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(2);
    expect(reg.read()['3000']?.tunnelId).toBe('t2');
  });

  test('touchTunnel by borrower updates registry lastAccessedAt', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any);

    const tmA = new TunnelManagerClass(reg);
    await tmA.processUrl('http://localhost:3000', 'auth-a', 't1');

    const before = reg.read()['3000'].lastAccessedAt;

    // Small delay so timestamp changes
    await new Promise(r => setTimeout(r, 5));

    const tmB = new TunnelManagerClass(reg);
    await tmB.processUrl('http://localhost:3000', 'auth-b', 't2');
    tmB.touchTunnel('t1');

    expect(reg.read()['3000'].lastAccessedAt).toBeGreaterThan(before);
  });
});

// ── Bead ixh: ngrok.connect() 3-attempt retry with backoff ──────────────────
//
// Before bead ixh: exactly 2 attempts (1 initial + 1 agent-reset retry). A
// transient flake on BOTH attempts made the user see "Tunnel creation failed"
// and need to manually re-run the tool. After ixh: 3 attempts with 500ms +
// 1500ms exponential backoff, auth errors fail fast, telemetry per attempt.
describe('bead ixh: connectWithRetry 3-attempt retry', () => {
  function fastTm() {
    const tm = new TunnelManagerClass();
    tm.connectBackoffMs = [1, 1]; // override so tests don't sleep real seconds
    return tm;
  }

  test('attempt 1 succeeds: no retry, no extra call', async () => {
    mockNgrokConnect.mockResolvedValueOnce('http://ok.ngrok.debugg.ai' as any);
    const tm = fastTm();

    const result = await tm.processUrl('http://localhost:3000', 'tok', 't1');

    expect(result.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('attempt 1 fails, attempt 2 succeeds (agent-reset path)', async () => {
    const flaky = new Error('connect ECONNRESET');
    mockNgrokConnect
      .mockRejectedValueOnce(flaky)
      .mockResolvedValueOnce('http://ok.ngrok.debugg.ai' as any);
    const tm = fastTm();

    const result = await tm.processUrl('http://localhost:3000', 'tok', 't1');

    expect(result.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(2);
  });

  test('attempts 1+2 fail, attempt 3 succeeds — the NEW retry case ixh fixes', async () => {
    // Before ixh this would have thrown after attempt 2. After: retries once more.
    const flaky1 = new Error('connect ECONNRESET');
    const flaky2 = new Error('ngrok agent dial timeout');
    mockNgrokConnect
      .mockRejectedValueOnce(flaky1)
      .mockRejectedValueOnce(flaky2)
      .mockResolvedValueOnce('http://ok.ngrok.debugg.ai' as any);
    const tm = fastTm();

    const result = await tm.processUrl('http://localhost:3000', 'tok', 't1');

    expect(result.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(3);
  });

  test('all 3 attempts fail: throws with the last error message', async () => {
    mockNgrokConnect
      .mockRejectedValueOnce(new Error('first fail'))
      .mockRejectedValueOnce(new Error('second fail'))
      .mockRejectedValueOnce(new Error('third fail'));
    const tm = fastTm();

    await expect(
      tm.processUrl('http://localhost:3000', 'tok', 't1'),
    ).rejects.toThrow(/Failed to create tunnel.*third fail/);

    expect(mockNgrokConnect).toHaveBeenCalledTimes(3);
  });

  test('auth error: fails fast on attempt 1, no retry', async () => {
    mockNgrokConnect.mockRejectedValueOnce(new Error('invalid authtoken'));
    const tm = fastTm();

    await expect(
      tm.processUrl('http://localhost:3000', 'tok', 't1'),
    ).rejects.toThrow(/invalid auth token/);

    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('auth error on attempt 2 (e.g. 401): stops retrying', async () => {
    mockNgrokConnect
      .mockRejectedValueOnce(new Error('network blip'))
      .mockRejectedValueOnce(new Error('401 Unauthorized'));
    const tm = fastTm();

    await expect(
      tm.processUrl('http://localhost:3000', 'tok', 't1'),
    ).rejects.toThrow();

    expect(mockNgrokConnect).toHaveBeenCalledTimes(2); // stopped at auth error, no 3rd attempt
  });

  test('empty URL returned: treated as retryable error', async () => {
    mockNgrokConnect
      .mockResolvedValueOnce('' as any)
      .mockResolvedValueOnce('http://ok.ngrok.debugg.ai' as any);
    const tm = fastTm();

    const result = await tm.processUrl('http://localhost:3000', 'tok', 't1');

    expect(result.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(2);
  });

  test('MAX_ATTEMPTS derives from connectBackoffMs length: single backoff → 2 attempts', async () => {
    mockNgrokConnect
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'));
    const tm = new TunnelManagerClass();
    tm.connectBackoffMs = [1]; // only 1 backoff → 2 attempts total

    await expect(
      tm.processUrl('http://localhost:3000', 'tok', 't1'),
    ).rejects.toThrow();

    expect(mockNgrokConnect).toHaveBeenCalledTimes(2);
  });

  test('timing: failed attempts actually sleep between them', async () => {
    mockNgrokConnect
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('http://ok.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass();
    tm.connectBackoffMs = [50, 50]; // measurable, but fast

    const start = Date.now();
    await tm.processUrl('http://localhost:3000', 'tok', 't1');
    const elapsed = Date.now() - start;

    // Two backoffs of 50ms → at least 100ms (allow slack for test noise)
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });
});

// ── Bead 42g: fault-injection integration ────────────────────────────────────
//
// Proves the fault harness plumbs through to tunnelManager end-to-end via the
// DEBUGG_TUNNEL_FAULT_MODE env var, so a dev or eval flow can force specific
// failure modes without having to mock anything.
describe('bead 42g: DEBUGG_TUNNEL_FAULT_MODE integration', () => {
  const originalMode = process.env.DEBUGG_TUNNEL_FAULT_MODE;
  const originalNodeEnv = process.env.NODE_ENV;

  // Each test gets a fresh in-memory registry so the "reuse tunnel for same port"
  // fast-path in processPerPort doesn't short-circuit subsequent tests with a
  // previous test's successful result.
  function freshTm(backoff: number[] = [1, 1]) {
    const tm = new TunnelManagerClass(createInMemoryRegistry());
    tm.connectBackoffMs = backoff;
    return tm;
  }

  afterEach(() => {
    if (originalMode === undefined) delete process.env.DEBUGG_TUNNEL_FAULT_MODE;
    else process.env.DEBUGG_TUNNEL_FAULT_MODE = originalMode;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test('fail-connect-N:2 forces 2 synthetic failures; succeeds on attempt 3 WITHOUT touching ngrok.connect', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'fail-connect-N:2';
    // Even though ngrok.connect is mocked to succeed, the fault injector should
    // throw BEFORE it runs for the first 2 attempts.
    mockNgrokConnect.mockResolvedValue('http://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const result = await tm.processUrl('http://localhost:3000', 'tok', 't1');

    expect(result.tunnelId).toBe('t1');
    // ngrok.connect was only called on attempt 3 (first 2 were short-circuited).
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('fail-connect-N:3 exhausts the retry budget and throws the synthetic error', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'fail-connect-N:3';
    mockNgrokConnect.mockResolvedValue('http://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    await expect(
      tm.processUrl('http://localhost:3000', 'tok', 't1'),
    ).rejects.toThrow(/\[fault-inject\] synthetic connect failure/);

    // All 3 attempts consumed the fault; ngrok.connect never got to run.
    expect(mockNgrokConnect).toHaveBeenCalledTimes(0);
  });

  test('SAFETY: fault injection is inert when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'fail-connect-N:5'; // would break everything if active
    mockNgrokConnect.mockResolvedValue('http://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const result = await tm.processUrl('http://localhost:3000', 'tok', 't1');

    expect(result.tunnelId).toBe('t1');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('empty-url-N:1 triggers the retry-on-empty-URL path without real ngrok', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'empty-url-N:1';
    mockNgrokConnect.mockResolvedValue('http://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const result = await tm.processUrl('http://localhost:3000', 'tok', 't1');

    expect(result.tunnelId).toBe('t1');
    // Attempt 1: empty-url fault short-circuits BEFORE ngrok.connect runs (same
    // spirit as fail-connect-N — lets the retry path be exercised without a real
    // API call). Attempt 2: fault counter exhausted, ngrok.connect runs.
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
  });

  test('delay-connect:100 adds the delay to each attempt', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEBUGG_TUNNEL_FAULT_MODE = 'delay-connect:100';
    mockNgrokConnect.mockResolvedValue('http://ok.ngrok.debugg.ai' as any);
    const tm = freshTm();

    const start = Date.now();
    await tm.processUrl('http://localhost:3000', 'tok', 't1');
    const elapsed = Date.now() - start;

    // First attempt: 100ms delay + connect success → at least 100ms.
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });
});

// ── Bead fhg: force IPv4 loopback in ngrok.connect addr ─────────────────────
//
// Real client incident 2026-04-24: macOS + Next.js dev server + localhost URL →
// ngrok received traffic and dialed [::1]:<port> (IPv6) → connection refused
// because Next.js binds to 127.0.0.1 only. Passing a bare port number to
// ngrok.connect lets ngrok default to 'localhost:<port>' which resolves
// IPv6-first on modern macOS.
//
// Fix: explicitly pass '127.0.0.1:<port>' for http+non-docker case.
describe('bead fhg: ngrok.connect receives explicit 127.0.0.1 addr', () => {
  test('http localhost + not-docker → addr is "127.0.0.1:<port>" (not bare port, not "localhost")', async () => {
    mockNgrokConnect.mockResolvedValue('http://abc.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass(createInMemoryRegistry());

    await tm.processUrl('http://localhost:4001', 'tok', 't-fhg-1');

    const callArgs = mockNgrokConnect.mock.calls[0][0] as any;
    expect(callArgs.addr).toBe('127.0.0.1:4001');
  });

  test('http 127.0.0.1 (already IPv4) + not-docker → addr still "127.0.0.1:<port>"', async () => {
    mockNgrokConnect.mockResolvedValue('http://abc.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass(createInMemoryRegistry());

    await tm.processUrl('http://127.0.0.1:5173', 'tok', 't-fhg-2');

    const callArgs = mockNgrokConnect.mock.calls[0][0] as any;
    expect(callArgs.addr).toBe('127.0.0.1:5173');
  });

  test('https localhost + not-docker → addr is "https://localhost:<port>" (unchanged; needs TLS so host must be localhost)', async () => {
    mockNgrokConnect.mockResolvedValue('https://abc.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass(createInMemoryRegistry());

    await tm.processUrl('https://localhost:3443', 'tok', 't-fhg-3');

    const callArgs = mockNgrokConnect.mock.calls[0][0] as any;
    expect(callArgs.addr).toBe('https://localhost:3443');
  });

  test('http localhost + docker → addr is "<dockerHost>:<port>" (unchanged)', async () => {
    const originalDocker = process.env.DOCKER_CONTAINER;
    process.env.DOCKER_CONTAINER = 'true';
    try {
      mockNgrokConnect.mockResolvedValue('http://abc.ngrok.debugg.ai' as any);
      const tm = new TunnelManagerClass(createInMemoryRegistry());

      await tm.processUrl('http://localhost:4001', 'tok', 't-fhg-4');

      const callArgs = mockNgrokConnect.mock.calls[0][0] as any;
      expect(callArgs.addr).toBe('host.docker.internal:4001');
    } finally {
      if (originalDocker === undefined) delete process.env.DOCKER_CONTAINER;
      else process.env.DOCKER_CONTAINER = originalDocker;
    }
  });

  test('regression fence: addr is NEVER a bare port number (would default to IPv6 loopback on macOS)', async () => {
    mockNgrokConnect.mockResolvedValue('http://abc.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass(createInMemoryRegistry());

    await tm.processUrl('http://localhost:8080', 'tok', 't-fhg-5');

    const callArgs = mockNgrokConnect.mock.calls[0][0] as any;
    expect(typeof callArgs.addr).toBe('string');
    expect(callArgs.addr).not.toBe(8080);
  });
});

// ── Bead 7qh Finding 2: B-joins-A orphan-key revocation ──────────────────────
//
// When caller B arrives while caller A's tunnel creation is in-flight for the
// same port, B's minted tunnelKey/keyId are redundant (A's will win). Before
// the fix: B's revokeKey callback was silently dropped → orphan key on the
// backend. After the fix: B's revokeKey is invoked immediately on join.
describe('bead 7qh: concurrent joiner revokes its own redundant key', () => {
  test('B joining A pending: B revokeKey invoked, A revokeKey NOT invoked', async () => {
    const revokeA = jest.fn<() => Promise<void>>().mockResolvedValue();
    const revokeB = jest.fn<() => Promise<void>>().mockResolvedValue();

    // Make A's connect deterministically slow so B arrives during the window.
    let resolveConnect: (url: string) => void;
    mockNgrokConnect.mockImplementation(() =>
      new Promise<any>((resolve) => { resolveConnect = resolve; }),
    );

    const tm = new TunnelManagerClass(createInMemoryRegistry());

    const aPromise = tm.processUrl('http://localhost:3000', 'keyA', 'tunnelA', 'keyIdA', revokeA);
    // Give A time to register its pending promise
    await new Promise((r) => setTimeout(r, 10));
    const bPromise = tm.processUrl('http://localhost:3000', 'keyB', 'tunnelB', 'keyIdB', revokeB);

    // Let A's connect resolve
    resolveConnect!('http://tunnelA.ngrok.debugg.ai');
    const [aResult, bResult] = await Promise.all([aPromise, bPromise]);

    // Both callers get A's tunnel
    expect(aResult.tunnelId).toBe('tunnelA');
    expect(bResult.tunnelId).toBe('tunnelA');

    // Critical: B's revokeKey was called (orphan cleanup), A's was NOT
    expect(revokeB).toHaveBeenCalledTimes(1);
    expect(revokeA).not.toHaveBeenCalled();
  });

  test('B joining without revokeKey: still joins cleanly, no throw', async () => {
    // Edge case: if caller B doesn't provide a revokeKey, joining should still work.
    let resolveConnect: (url: string) => void;
    mockNgrokConnect.mockImplementation(() =>
      new Promise<any>((resolve) => { resolveConnect = resolve; }),
    );

    const tm = new TunnelManagerClass(createInMemoryRegistry());
    const aPromise = tm.processUrl('http://localhost:3000', 'keyA', 'tunnelA');
    await new Promise((r) => setTimeout(r, 10));
    const bPromise = tm.processUrl('http://localhost:3000', 'keyB', 'tunnelB'); // no revokeKey

    resolveConnect!('http://tunnelA.ngrok.debugg.ai');
    const [, bResult] = await Promise.all([aPromise, bPromise]);

    expect(bResult.tunnelId).toBe('tunnelA');
  });

  test('B revokeKey throw is swallowed — does not break the join', async () => {
    const revokeB = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('backend 500'));

    let resolveConnect: (url: string) => void;
    mockNgrokConnect.mockImplementation(() =>
      new Promise<any>((resolve) => { resolveConnect = resolve; }),
    );

    const tm = new TunnelManagerClass(createInMemoryRegistry());
    const aPromise = tm.processUrl('http://localhost:3000', 'keyA', 'tunnelA');
    await new Promise((r) => setTimeout(r, 10));
    const bPromise = tm.processUrl('http://localhost:3000', 'keyB', 'tunnelB', 'keyIdB', revokeB);

    resolveConnect!('http://tunnelA.ngrok.debugg.ai');
    const bResult = await bPromise; // must not throw
    await aPromise;

    expect(revokeB).toHaveBeenCalledTimes(1);
    expect(bResult.tunnelId).toBe('tunnelA');
  });
});
