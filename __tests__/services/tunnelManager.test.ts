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

// Bead pqgj: the manager now pre-warms the ngrok agent's client session before
// tunnelling. The real starter deep-requires ngrok's internals and SPAWNS AN
// ACTUAL AGENT PROCESS — which a unit suite must never do (it also reaches past
// the 'ngrok' mock above). Stub it with a faithful stand-in: agent started,
// session established immediately. Assertions below are unchanged.
const mockStartAgentSession = jest.fn(async (opts: any) => { opts.onStatusChange('connected'); });

jest.unstable_mockModule('../../services/ngrok/ngrokAgentSession.js', () => ({
  startAgentSession: mockStartAgentSession,
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

  // ── Bead `3th`: PID-reuse vulnerability — freshness check overrides PID liveness ──
  test('PID-reuse defense: stale entry rejected even when PID is "alive" (bead 3th)', async () => {
    // Simulate: Process A died, OS reassigned its PID to Process Z (unrelated).
    // isPidAlive returns true (Z is running), but no one is touching the
    // registry entry — so it's older than the freshness TTL and we reject.
    const reg = createInMemoryRegistry(() => true); // PID "alive"
    const tm = new TunnelManagerClass(reg);

    // Bead y7x6 widened the freshness TTL from a hard-coded 30 min to the
    // tunnel's own idle timeout. Expressing "stale" relative to that constant
    // instead of hard-coding 31 min keeps this test testing PID-reuse rather
    // than silently becoming a test of a number nobody updates. Written AFTER
    // construction so the startup prune doesn't sweep it before the borrow
    // check gets to reject it.
    const staleBy = tm.idleTimeoutMs + 60_000;
    reg.write({
      '3000': {
        tunnelId: 'reused-pid-t1',
        publicUrl: 'https://reused-pid-t1.ngrok.debugg.ai/',
        tunnelUrl: 'http://reused-pid-t1.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 99999,
        lastAccessedAt: Date.now() - staleBy,
      },
    });

    mockNgrokConnect.mockResolvedValueOnce('http://fresh-t.ngrok.debugg.ai' as any);

    const result = await tm.processUrl('http://localhost:3000', 'auth-b', 'fresh-t');

    // Despite alive PID, stale entry was NOT borrowed — fresh tunnel created
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
    expect(result.tunnelId).toBe('fresh-t');
  });

  test('PID-reuse defense: fresh entry borrowed normally (alive PID + recent access)', async () => {
    const reg = createInMemoryRegistry(() => true);
    reg.write({
      '3000': {
        tunnelId: 'fresh-t1',
        publicUrl: 'https://fresh-t1.ngrok.debugg.ai/',
        tunnelUrl: 'http://fresh-t1.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 99999,
        lastAccessedAt: Date.now() - 1000, // 1 sec ago — well within freshness
      },
    });

    const tm = new TunnelManagerClass(reg);
    const result = await tm.processUrl('http://localhost:3000', 'auth-b', 'unused');

    // Borrowed — no fresh ngrok.connect needed
    expect(mockNgrokConnect).not.toHaveBeenCalled();
    expect(result.tunnelId).toBe('fresh-t1');
  });

  // ── Bead `mdp`: prune-on-startup ─────────────────────────────────────────
  test('startup prune: removes dead-PID and stale entries from registry (bead mdp)', () => {
    let aliveSet = new Set<number>([42]); // only PID 42 is alive
    const reg = createInMemoryRegistry((pid) => aliveSet.has(pid));
    const now = Date.now();
    reg.write({
      '3000': { // alive PID + fresh — keep
        tunnelId: 'keep-1', publicUrl: '', tunnelUrl: '', port: 3000,
        ownerPid: 42, lastAccessedAt: now - 1000,
      },
      '4000': { // dead PID — prune
        tunnelId: 'dead-pid', publicUrl: '', tunnelUrl: '', port: 4000,
        ownerPid: 99999, lastAccessedAt: now - 1000,
      },
      '5000': { // alive PID but stale (61 min) — prune
        tunnelId: 'stale-1', publicUrl: '', tunnelUrl: '', port: 5000,
        ownerPid: 42, lastAccessedAt: now - (61 * 60 * 1000),
      },
      '6000': { // dead AND stale — prune
        tunnelId: 'double-bad', publicUrl: '', tunnelUrl: '', port: 6000,
        ownerPid: 99998, lastAccessedAt: now - (61 * 60 * 1000),
      },
    });

    new TunnelManagerClass(reg); // constructor calls reg.prune()

    const after = reg.read();
    expect(Object.keys(after).sort()).toEqual(['3000']);
    expect(after['3000'].tunnelId).toBe('keep-1');
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

  // ── Bead k34o: a borrower that PROVES a tunnel dead (ERR_NGROK_3200) must evict
  //    the shared registry entry, or every subsequent call re-borrows the corpse. ──
  describe('markTunnelDead — evict a confirmed-dead tunnel so it stops poisoning reuse', () => {
    test('evicts the shared registry entry (unlike stopTunnel) so the next call re-provisions', async () => {
      const reg = createInMemoryRegistry(() => true);
      mockNgrokConnect.mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any);

      const tmA = new TunnelManagerClass(reg);
      await tmA.processUrl('http://localhost:3000', 'auth-a', 't1');
      const tmB = new TunnelManagerClass(reg);
      await tmB.processUrl('http://localhost:3000', 'auth-b', 't2');
      expect(tmB.getTunnelForPort(3000)?.tunnelId).toBe('t1'); // borrowed t1

      // B's health probe came back ERR_NGROK_3200 — t1 is dead. Evict it.
      tmB.markTunnelDead(3000, 't1');

      // Local ref dropped AND the shared registry entry is gone (the fix).
      expect(tmB.getActiveTunnels()).toHaveLength(0);
      expect(reg.read()['3000']).toBeUndefined();

      // A subsequent call provisions FRESH instead of re-borrowing the corpse.
      jest.clearAllMocks();
      mockNgrokConnect.mockResolvedValueOnce('http://fresh.ngrok.debugg.ai' as any);
      const next = await tmB.processUrl('http://localhost:3000', 'auth-c', 'fresh-t');
      expect(next.tunnelId).toBe('fresh-t');
      expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
    });

    test('guard: does NOT evict a replacement entry with a different tunnelId', () => {
      const reg = createInMemoryRegistry(() => true);
      reg.write({
        '3000': {
          tunnelId: 'replacement-t2', // a fresh tunnel already replaced the dead one
          publicUrl: 'https://replacement-t2.ngrok.debugg.ai/',
          tunnelUrl: 'http://replacement-t2.ngrok.debugg.ai',
          port: 3000,
          ownerPid: 99999,
          lastAccessedAt: Date.now(),
        },
      });
      const tm = new TunnelManagerClass(reg);
      tm.markTunnelDead(3000, 'dead-t1'); // the OLD, already-replaced id
      expect(reg.read()['3000']?.tunnelId).toBe('replacement-t2'); // preserved
    });
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

// ── Bead y7x6: registry freshness must not expire before the tunnel does ─────
//
// The freshness TTL was a hard-coded 30 minutes while a tunnel idled for 55, so
// for a 25-minute stretch the registry called an entry unusable while the
// tunnel it named was alive and BILLING. The next request provisioned a
// duplicate and overwrote the entry, orphaning the original — a systematic
// double-bill, not a race.
describe('bead y7x6: freshness TTL is derived from the idle timeout', () => {
  /**
   * The shipped idle window, read off the class so these cannot go stale.
   * Resolved lazily — the class only exists after the mocked import in beforeAll.
   */
  const defaultIdleMs = () => new TunnelManagerClass(createInMemoryRegistry()).idleTimeoutMs;

  /**
   * Is an entry of this age still borrowed rather than duplicated? Asked
   * behaviourally — through processUrl — because "did we spend another billed
   * hour" is the only thing that actually matters here.
   */
  async function borrowsEntryAged(ageMs: number, idleTimeoutMs?: number): Promise<boolean> {
    mockNgrokConnect.mockReset();
    mockNgrokConnect.mockResolvedValue('http://replacement.ngrok.debugg.ai' as any);

    const reg = createInMemoryRegistry(() => true);
    const tm = new TunnelManagerClass(reg);
    if (idleTimeoutMs !== undefined) tm.idleTimeoutMs = idleTimeoutMs;
    // Written after construction so the startup prune isn't the thing under test.
    reg.write({
      '3000': {
        tunnelId: 'aged-t1',
        publicUrl: 'https://aged-t1.ngrok.debugg.ai/',
        tunnelUrl: 'http://aged-t1.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 4242,
        lastAccessedAt: Date.now() - ageMs,
      },
    });

    const result = await tm.processUrl('http://localhost:3000', 'auth', 'replacement');
    await tm.stopAllTunnels();
    return result.tunnelId === 'aged-t1';
  }

  test('THE REGRESSION FENCE: an entry stays borrowable right up to the idle timeout', async () => {
    // Any entry younger than the tunnel's own idle window names a tunnel that
    // has not shut itself off yet. If these two constants ever diverge again,
    // every request landing in the gap buys a second billed hour.
    await expect(borrowsEntryAged(defaultIdleMs() - 1000)).resolves.toBe(true);
  });

  test('NO guard band is subtracted — a band is just a narrower dead zone', async () => {
    await expect(borrowsEntryAged(defaultIdleMs() - 1)).resolves.toBe(true);
  });

  test('the whole old 30–55 minute dead zone is borrowable again', async () => {
    for (const minutes of [30, 35, 45, 54]) {
      await expect(borrowsEntryAged(minutes * 60 * 1000)).resolves.toBe(true);
    }
  });

  test('past the idle timeout the entry is correctly rejected — that tunnel is gone', async () => {
    await expect(borrowsEntryAged(defaultIdleMs() + 60_000)).resolves.toBe(false);
  });

  test('the TTL tracks idleTimeoutMs rather than a constant of its own', async () => {
    // Shrink the idle window: an age that was fine at 55 minutes is now stale.
    await expect(borrowsEntryAged(10 * 60 * 1000, 60_000)).resolves.toBe(false);
    await expect(borrowsEntryAged(30_000, 60_000)).resolves.toBe(true);
  });

  test('borrowing in the old dead zone provisions nothing at all', async () => {
    mockNgrokConnect.mockReset();
    const reg = createInMemoryRegistry(() => true);
    const tm = new TunnelManagerClass(reg);
    reg.write({
      '3000': {
        tunnelId: 'alive-and-billing',
        publicUrl: 'https://alive-and-billing.ngrok.debugg.ai/',
        tunnelUrl: 'http://alive-and-billing.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 4242,
        lastAccessedAt: Date.now() - 40 * 60 * 1000, // squarely in the old gap
      },
    });

    const result = await tm.processUrl('http://localhost:3000', 'auth', 'would-be-duplicate');
    await tm.stopAllTunnels();

    expect(mockNgrokConnect).not.toHaveBeenCalled();
    expect(result.tunnelId).toBe('alive-and-billing');
  });
});

// ── Bead lc62: a live tunnel must never become undiscoverable ────────────────

describe('bead lc62 fix 1: auto-shutoff extension is scoped to OUR tunnelId', () => {
  /** Drives the 55-minute idle timer in milliseconds. */
  function fastTimerTm(reg: ReturnType<typeof createInMemoryRegistry>) {
    const tm = new TunnelManagerClass(reg);
    tm.idleTimeoutMs = 25;
    return tm;
  }
  const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

  function keepEntryHot(reg: ReturnType<typeof createInMemoryRegistry>) {
    return setInterval(() => {
      const r = reg.read();
      if (r['3000']) { r['3000'].lastAccessedAt = Date.now(); reg.write(r); }
    }, 5);
  }

  test('a DISPLACED tunnel reaps itself instead of living off its replacement', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://displaced.ngrok.debugg.ai' as any);
    const tm = fastTimerTm(reg);
    await tm.processUrl('http://localhost:3000', 'auth', 'displaced');
    expect(tm.getActiveTunnels()).toHaveLength(1);

    // Another session provisions a replacement for the same port and keeps it
    // hot. Keyed only by port, the old tunnel used to read that as its own
    // activity and extend forever — an orphan nobody could reach, billing
    // indefinitely. That is what turns a 55-minute mistake into a multi-day one.
    reg.write({
      '3000': {
        tunnelId: 'replacement',
        publicUrl: 'https://replacement.ngrok.debugg.ai/',
        tunnelUrl: 'http://replacement.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 4242,
        lastAccessedAt: Date.now(),
      },
    });
    const hot = keepEntryHot(reg);
    try {
      await settle();
      expect(tm.getActiveTunnels()).toHaveLength(0);
      expect(mockNgrokDisconnect).toHaveBeenCalledWith('http://displaced.ngrok.debugg.ai');
    } finally {
      clearInterval(hot);
    }
  });

  test('the replacement entry survives the displaced tunnel shutting down', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://displaced.ngrok.debugg.ai' as any);
    const tm = fastTimerTm(reg);
    await tm.processUrl('http://localhost:3000', 'auth', 'displaced');

    reg.write({
      '3000': {
        tunnelId: 'replacement',
        publicUrl: 'https://replacement.ngrok.debugg.ai/',
        tunnelUrl: 'http://replacement.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 4242,
        lastAccessedAt: Date.now(),
      },
    });

    await settle();
    // stopTunnel must not delete an entry naming a DIFFERENT, live tunnel.
    expect(reg.read()['3000']?.tunnelId).toBe('replacement');
  });

  test('OUR OWN entry, freshly touched, still extends the tunnel', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://mine.ngrok.debugg.ai' as any);
    const tm = fastTimerTm(reg);
    await tm.processUrl('http://localhost:3000', 'auth', 'mine');

    const hot = keepEntryHot(reg);
    try {
      await settle();
      // Cross-process keep-alive is the entire reason the extension exists;
      // scoping it by tunnelId must not break it.
      expect(tm.getActiveTunnels()).toHaveLength(1);
    } finally {
      clearInterval(hot);
      await tm.stopAllTunnels();
    }
  });
});

describe('bead lc62 fix 2: an owned tunnel re-registers itself', () => {
  test('touchTunnel restores an entry pruned out from under a live tunnel', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass(reg);
    await tm.processUrl('http://localhost:3000', 'auth', 't1');

    reg.write({}); // another MCP's startup prune swept it; the tunnel is untouched
    tm.touchTunnel('t1');

    const restored = reg.read()['3000'];
    expect(restored?.tunnelId).toBe('t1');
    expect(restored?.ownerPid).toBe(process.pid);
    expect(restored?.tunnelUrl).toBe('http://t1.ngrok.debugg.ai');
    await tm.stopAllTunnels();
  });

  test('the reuse path re-registers too — in-process reuse used to be invisible', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass(reg);
    await tm.processUrl('http://localhost:3000', 'auth', 't1');

    reg.write({});
    const result = await tm.processUrl('http://localhost:3000/other', 'auth', 't2');

    expect(result.tunnelId).toBe('t1');              // reused, not re-provisioned
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
    expect(reg.read()['3000']?.tunnelId).toBe('t1'); // and discoverable again
    await tm.stopAllTunnels();
  });

  test('a BORROWED tunnel does not re-register — we are not its owner', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://t1.ngrok.debugg.ai' as any);
    const tmA = new TunnelManagerClass(reg);
    await tmA.processUrl('http://localhost:3000', 'auth-a', 't1');
    const tmB = new TunnelManagerClass(reg);
    await tmB.processUrl('http://localhost:3000', 'auth-b', 't2');

    reg.write({}); // entry vanishes
    tmB.touchTunnel('t1');

    // B claiming ownerPid over someone else's tunnel is a lie the real owner
    // then trips over when IT stops.
    expect(reg.read()['3000']).toBeUndefined();
    await tmA.stopAllTunnels();
  });

  test('a foreign entry on our port is left completely alone', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://mine.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass(reg);
    await tm.processUrl('http://localhost:3000', 'auth', 'mine');

    const foreignStamp = Date.now() - 5000;
    reg.write({
      '3000': {
        tunnelId: 'someone-elses',
        publicUrl: 'https://someone-elses.ngrok.debugg.ai/',
        tunnelUrl: 'http://someone-elses.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 4242,
        lastAccessedAt: foreignStamp,
      },
    });

    tm.touchTunnel('mine');

    const after = reg.read()['3000'];
    expect(after.tunnelId).toBe('someone-elses');    // not overwritten
    expect(after.lastAccessedAt).toBe(foreignStamp); // and not even refreshed
    await tm.stopAllTunnels();
  });
});

describe('bead lc62 fix 3: re-adopt live tunnels from the local ngrok agent', () => {
  function inspectorReturning(tunnels: Array<{ tunnelId: string; port: number }>) {
    return {
      listLiveTunnels: async () => tunnels.map((t) => ({
        tunnelId: t.tunnelId,
        publicUrl: `https://${t.tunnelId}.ngrok.debugg.ai`,
        port: t.port,
      })),
    };
  }

  test('an orphan whose owner was SIGKILLed is adopted instead of duplicated', async () => {
    // Owner died: no registry entry survives the dead-PID prune, but the ngrok
    // agent it spawned outlived it and the tunnel is still open and billing.
    const reg = createInMemoryRegistry(() => true);
    const tm = new TunnelManagerClass(reg);
    tm.tunnelInspector = inspectorReturning([{ tunnelId: 'orphan-t', port: 3000 }]);

    const result = await tm.processUrl('http://localhost:3000/app', 'auth', 'would-be-new');

    expect(mockNgrokConnect).not.toHaveBeenCalled();
    expect(result.tunnelId).toBe('orphan-t');
    // Bead zmc9: an adopted tunnel is retargeted at THIS caller's path.
    expect(result.url).toBe('https://orphan-t.ngrok.debugg.ai/app');
    expect(reg.read()['3000']?.tunnelId).toBe('orphan-t');
    await tm.stopAllTunnels();
  });

  test('an adopted tunnel is BORROWED, never claimed as owned', async () => {
    const reg = createInMemoryRegistry(() => true);
    const tm = new TunnelManagerClass(reg);
    tm.tunnelInspector = inspectorReturning([{ tunnelId: 'orphan-t', port: 3000 }]);
    await tm.processUrl('http://localhost:3000', 'auth', 'unused');

    expect(tm.getTunnelInfo('orphan-t')?.isOwned).toBe(false);
    // So stopping it must not try to disconnect a session we never created.
    await tm.stopTunnel('orphan-t');
    expect(mockNgrokDisconnect).not.toHaveBeenCalled();
  });

  test('THE SAFETY PROPERTY: an inspector that observes nothing changes nothing', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://fresh.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass(reg);
    tm.tunnelInspector = inspectorReturning([]);

    const result = await tm.processUrl('http://localhost:3000', 'auth', 'fresh');

    // Exactly today's behaviour: nothing known, so provision. A blind inspector
    // can never be the reason we spend — or fail to spend — a billed hour.
    expect(result.tunnelId).toBe('fresh');
    expect(mockNgrokConnect).toHaveBeenCalledTimes(1);
    await tm.stopAllTunnels();
  });

  test('an inspector that THROWS is absorbed and provisioning proceeds', async () => {
    const reg = createInMemoryRegistry(() => true);
    mockNgrokConnect.mockResolvedValueOnce('http://fresh.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass(reg);
    tm.tunnelInspector = { listLiveTunnels: async () => { throw new Error('agent API moved'); } };

    await expect(tm.processUrl('http://localhost:3000', 'auth', 'fresh'))
      .resolves.toMatchObject({ tunnelId: 'fresh' });
    await tm.stopAllTunnels();
  });

  test('reconciliation is ADD-ONLY — a usable entry is never displaced', async () => {
    const reg = createInMemoryRegistry(() => true);
    const tm = new TunnelManagerClass(reg);
    reg.write({
      '3000': {
        tunnelId: 'working-t',
        publicUrl: 'https://working-t.ngrok.debugg.ai/',
        tunnelUrl: 'http://working-t.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 4242,
        lastAccessedAt: Date.now(),
      },
    });
    tm.tunnelInspector = inspectorReturning([{ tunnelId: 'other-live-t', port: 3000 }]);

    const result = await tm.processUrl('http://localhost:3000', 'auth', 'unused');

    // The usable entry wins outright; nothing is deleted or rewritten.
    expect(result.tunnelId).toBe('working-t');
    expect(reg.read()['3000'].tunnelId).toBe('working-t');
    await tm.stopAllTunnels();
  });

  test('an UNUSABLE entry IS replaced by a tunnel proven live', async () => {
    const reg = createInMemoryRegistry((pid) => pid === process.pid); // 99999 is dead
    const tm = new TunnelManagerClass(reg);
    reg.write({
      '3000': {
        tunnelId: 'stale-t',
        publicUrl: 'https://stale-t.ngrok.debugg.ai/',
        tunnelUrl: 'http://stale-t.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 99999,
        lastAccessedAt: Date.now(),
      },
    });
    tm.tunnelInspector = inspectorReturning([{ tunnelId: 'actually-live', port: 3000 }]);

    const result = await tm.processUrl('http://localhost:3000', 'auth', 'unused');
    expect(mockNgrokConnect).not.toHaveBeenCalled();
    expect(result.tunnelId).toBe('actually-live');
    await tm.stopAllTunnels();
  });

  test('the agent scan runs at most once per process', async () => {
    const reg = createInMemoryRegistry(() => true);
    let calls = 0;
    mockNgrokConnect.mockResolvedValue('http://fresh.ngrok.debugg.ai' as any);
    const tm = new TunnelManagerClass(reg);
    tm.tunnelInspector = { listLiveTunnels: async () => { calls++; return []; } };

    await tm.processUrl('http://localhost:3000', 'auth', 'fresh-a');
    await tm.processUrl('http://localhost:4000', 'auth', 'fresh-b');

    expect(calls).toBe(1);
    await tm.stopAllTunnels();
  });

  test('a manager that only ever borrows never pays for a scan', async () => {
    const reg = createInMemoryRegistry(() => true);
    let calls = 0;
    const tm = new TunnelManagerClass(reg);
    tm.tunnelInspector = { listLiveTunnels: async () => { calls++; return []; } };
    reg.write({
      '3000': {
        tunnelId: 'borrow-me',
        publicUrl: 'https://borrow-me.ngrok.debugg.ai/',
        tunnelUrl: 'http://borrow-me.ngrok.debugg.ai',
        port: 3000,
        ownerPid: 4242,
        lastAccessedAt: Date.now(),
      },
    });

    await tm.processUrl('http://localhost:3000', 'auth', 'unused');

    // The scan only happens on the path that is about to spend money.
    expect(calls).toBe(0);
    await tm.stopAllTunnels();
  });

  test('borrowing never issues a request to a *.ngrok.debugg.ai host', async () => {
    // The k6yq / z15n / kmzb failure class: probing the PUBLIC url for a reuse
    // decision reads a live tunnel as dead and replaces it. Liveness evidence
    // must come from loopback only.
    const realFetch = globalThis.fetch;
    const fetchSpy = jest.fn(async () => new Response('nope'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const reg = createInMemoryRegistry(() => true);
      const tm = new TunnelManagerClass(reg);
      reg.write({
        '3000': {
          tunnelId: 'borrow-me',
          publicUrl: 'https://borrow-me.ngrok.debugg.ai/',
          tunnelUrl: 'http://borrow-me.ngrok.debugg.ai',
          port: 3000,
          ownerPid: 4242,
          lastAccessedAt: Date.now(),
        },
      });

      const result = await tm.processUrl('http://localhost:3000', 'auth', 'unused');

      expect(result.tunnelId).toBe('borrow-me');
      expect(fetchSpy).not.toHaveBeenCalled();
      await tm.stopAllTunnels();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
