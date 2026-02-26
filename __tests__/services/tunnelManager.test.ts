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
    expect(opts.addr).toBe(3000); // number for plain http
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
