/**
 * Tests for utils/tunnelContext.ts
 *
 * Covers:
 *  - resolveTargetUrl
 *  - buildContext
 *  - findExistingTunnel / ensureTunnel (now session-keyed, §2.1)
 *  - releaseTunnel
 *  - sanitizeResponseUrls
 */

import { jest } from '@jest/globals';

// Mock tunnelManager before importing the module under test. getSessionKey
// is a real, pure function of request-scoped state (utils/requestContext.ts)
// with no external effects — mocking it to a fixed value keeps these tests
// decoupled from AsyncLocalStorage plumbing they don't need to exercise.
const mockEnsureSessionTunnel = jest.fn<(...args: any[]) => Promise<any>>();
const mockStopTunnel = jest.fn<(...args: any[]) => Promise<any>>();
const mockGetSessionTunnelInfo = jest.fn<(sessionKey: string) => any>();
const mockGetTunnelInfo = jest.fn<(tunnelId: string) => any>();
const mockTouchTunnel = jest.fn<(tunnelId: string) => void>();
const mockGetSessionKey = jest.fn<() => string>(() => 'sess-fixed');

jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: {
    ensureSessionTunnel: mockEnsureSessionTunnel,
    stopTunnel: mockStopTunnel,
    getSessionTunnelInfo: mockGetSessionTunnelInfo,
    getTunnelInfo: mockGetTunnelInfo,
    touchTunnel: mockTouchTunnel,
  },
  getSessionKey: mockGetSessionKey,
}));

const {
  resolveTargetUrl,
  buildContext,
  findExistingTunnel,
  ensureTunnel,
  acquirePortRoute,
  releasePortRoute,
  releaseTunnel,
  sanitizeResponseUrls,
} = await import('../../utils/tunnelContext.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSessionKey.mockReturnValue('sess-fixed');
});

// ── resolveTargetUrl ─────────────────────────────────────────────────────────

describe('resolveTargetUrl', () => {
  test('returns the url property from the input', () => {
    expect(resolveTargetUrl({ url: 'http://localhost:3000' })).toBe('http://localhost:3000');
  });

  test('returns public URL unchanged', () => {
    expect(resolveTargetUrl({ url: 'https://example.com/app' })).toBe('https://example.com/app');
  });
});

// ── buildContext ─────────────────────────────────────────────────────────────

describe('buildContext', () => {
  test('public URL: isLocalhost is false', () => {
    const ctx = buildContext('https://example.com');
    expect(ctx.originalUrl).toBe('https://example.com');
    expect(ctx.isLocalhost).toBe(false);
    expect(ctx.tunnelId).toBeUndefined();
    expect(ctx.targetUrl).toBeUndefined();
  });

  test('localhost URL: isLocalhost is true', () => {
    const ctx = buildContext('http://localhost:3000');
    expect(ctx.originalUrl).toBe('http://localhost:3000');
    expect(ctx.isLocalhost).toBe(true);
  });

  test('127.0.0.1 URL: isLocalhost is true', () => {
    const ctx = buildContext('http://127.0.0.1:8080');
    expect(ctx.isLocalhost).toBe(true);
  });
});

// ── findExistingTunnel ───────────────────────────────────────────────────────

describe('findExistingTunnel', () => {
  test('public URL: returns null without checking the session tunnel', () => {
    const ctx = buildContext('https://example.com');
    expect(findExistingTunnel(ctx)).toBeNull();
    expect(mockGetSessionTunnelInfo).not.toHaveBeenCalled();
  });

  test('localhost but this session has no active tunnel: returns null', () => {
    const ctx = buildContext('http://localhost:3000');
    mockGetSessionTunnelInfo.mockReturnValueOnce(undefined);

    expect(findExistingTunnel(ctx)).toBeNull();
    expect(mockGetSessionTunnelInfo).toHaveBeenCalledWith('sess-fixed');
    expect(mockTouchTunnel).not.toHaveBeenCalled();
  });

  test('localhost with an existing session tunnel: returns enriched ctx and touches it', () => {
    const ctx = buildContext('http://localhost:3000');
    mockGetSessionTunnelInfo.mockReturnValueOnce({
      tunnelId: 'existing-t1',
      tunnelUrl: 'https://existing-t1.ngrok.debugg.ai',
    });

    const result = findExistingTunnel(ctx);

    expect(result).not.toBeNull();
    expect(result!.tunnelId).toBe('existing-t1');
    expect(result!.targetUrl).toBe('https://existing-t1.ngrok.debugg.ai/');
    expect(result!.isLocalhost).toBe(true);
    expect(result!.originalUrl).toBe('http://localhost:3000');
    expect(mockTouchTunnel).toHaveBeenCalledWith('existing-t1');
  });

  // Bead zmc9: the session tunnel's bare origin (tunnelUrl) must be retargeted
  // to THIS caller's own path — never a path baked in by a different call.
  test('zmc9: reuse retargets to the CALLER path, not a path baked into a previous URL', () => {
    const ctx = buildContext('http://localhost:3011/dashboard?tab=1#top');
    mockGetSessionTunnelInfo.mockReturnValueOnce({
      tunnelId: 'abc123',
      tunnelUrl: 'https://abc123.ngrok.debugg.ai',
    });

    const result = findExistingTunnel(ctx);

    expect(result!.tunnelId).toBe('abc123');
    expect(result!.targetUrl).toBe('https://abc123.ngrok.debugg.ai/dashboard?tab=1#top');
  });

  test('zmc9: a root-path caller does not inherit any deep path from a previous caller', () => {
    const ctx = buildContext('http://localhost:3011/');
    mockGetSessionTunnelInfo.mockReturnValueOnce({
      tunnelId: 'abc123',
      tunnelUrl: 'https://abc123.ngrok.debugg.ai',
    });

    const result = findExistingTunnel(ctx);

    expect(result!.targetUrl).toBe('https://abc123.ngrok.debugg.ai/');
  });
});

// ── ensureTunnel ─────────────────────────────────────────────────────────────

describe('ensureTunnel', () => {
  test('non-localhost ctx: returns same ctx, ensureSessionTunnel NOT called', async () => {
    const ctx = buildContext('https://example.com');
    const result = await ensureTunnel(ctx, 'key-1', 'tid-1');
    expect(result).toBe(ctx);
    expect(mockEnsureSessionTunnel).not.toHaveBeenCalled();
  });

  test('localhost ctx: calls ensureSessionTunnel with this session\'s key and returns enriched ctx', async () => {
    const ctx = buildContext('http://localhost:3000');
    mockEnsureSessionTunnel.mockResolvedValueOnce({
      tunnelId: 'tid-1',
      tunnelUrl: 'https://tid-1.ngrok.debugg.ai',
    });

    const result = await ensureTunnel(ctx, 'key-1', 'tid-1');
    expect(mockEnsureSessionTunnel).toHaveBeenCalledWith(
      'sess-fixed', 'key-1', 'tid-1', undefined, undefined
    );
    expect(result.tunnelId).toBe('tid-1');
    expect(result.targetUrl).toBe('https://tid-1.ngrok.debugg.ai/');
    expect(result.originalUrl).toBe('http://localhost:3000');
    expect(result.isLocalhost).toBe(true);
  });

  test('retargets the session tunnel\'s bare origin to THIS call\'s path', async () => {
    const ctx = buildContext('http://localhost:3000/api/widgets');
    mockEnsureSessionTunnel.mockResolvedValueOnce({
      tunnelId: 'tid-1',
      tunnelUrl: 'https://tid-1.ngrok.debugg.ai',
    });

    const result = await ensureTunnel(ctx, 'key-1', 'tid-1');
    expect(result.targetUrl).toBe('https://tid-1.ngrok.debugg.ai/api/widgets');
  });

  test('forwards keyId and revokeKey to ensureSessionTunnel', async () => {
    const ctx = buildContext('http://localhost:3000');
    mockEnsureSessionTunnel.mockResolvedValueOnce({ tunnelId: 'tid-1', tunnelUrl: 'https://tid-1.ngrok.debugg.ai' });
    const revokeKey = jest.fn();

    await ensureTunnel(ctx, 'key-1', 'tid-1', 'kid-1', revokeKey);

    expect(mockEnsureSessionTunnel).toHaveBeenCalledWith(
      'sess-fixed', 'key-1', 'tid-1', 'kid-1', revokeKey
    );
  });

  test('ensureSessionTunnel throws: error propagates', async () => {
    const ctx = buildContext('http://localhost:3000');
    mockEnsureSessionTunnel.mockRejectedValueOnce(new Error('tunnel failed'));

    await expect(ensureTunnel(ctx, 'key-1', 'tid-1')).rejects.toThrow('tunnel failed');
  });
});

// ── acquirePortRoute / releasePortRoute (§2.4) ──────────────────────────────

describe('acquirePortRoute', () => {
  test('public URL (no tunnelId): returns ctx unchanged, never touches tunnelManager', async () => {
    const ctx = buildContext('https://example.com');
    const result = await acquirePortRoute(ctx, { callId: 'call-1' });
    expect(result).toBe(ctx);
    expect(mockGetTunnelInfo).not.toHaveBeenCalled();
  });

  test('localhost ctx without a tunnelId yet: returns ctx unchanged (no route to acquire)', async () => {
    const ctx = buildContext('http://localhost:3000');
    expect(ctx.tunnelId).toBeUndefined();
    const result = await acquirePortRoute(ctx, { callId: 'call-1' });
    expect(result).toBe(ctx);
    expect(mockGetTunnelInfo).not.toHaveBeenCalled();
  });

  test('localhost ctx with a tunnelId: looks up TunnelInfo and acquires its portLock for this port', async () => {
    const ctx = buildContext('http://localhost:3000');
    const withTunnel = { ...ctx, tunnelId: 'tid-1', targetUrl: 'https://tid-1.ngrok.debugg.ai/' };
    const mockHandle = { port: 3000, callId: 'call-1', release: jest.fn() };
    const mockAcquire = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(mockHandle);
    mockGetTunnelInfo.mockReturnValueOnce({ tunnelId: 'tid-1', portLock: { acquire: mockAcquire } });

    const result = await acquirePortRoute(withTunnel, { callId: 'call-1' });

    expect(mockGetTunnelInfo).toHaveBeenCalledWith('tid-1');
    expect(mockAcquire).toHaveBeenCalledWith(
      { port: 3000, isHttpsLocal: false },
      expect.objectContaining({ callId: 'call-1' }),
    );
    expect(result.routeLock).toBe(mockHandle);
    // Original ctx fields preserved.
    expect(result.tunnelId).toBe('tid-1');
    expect(result.targetUrl).toBe('https://tid-1.ngrok.debugg.ai/');
  });

  test('https localhost ctx: passes isHttpsLocal:true through to portLock.acquire', async () => {
    const ctx = buildContext('https://localhost:3443');
    const withTunnel = { ...ctx, tunnelId: 'tid-2' };
    const mockAcquire = jest.fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ port: 3443, callId: 'call-2', release: jest.fn() });
    mockGetTunnelInfo.mockReturnValueOnce({ tunnelId: 'tid-2', portLock: { acquire: mockAcquire } });

    await acquirePortRoute(withTunnel, { callId: 'call-2' });

    expect(mockAcquire).toHaveBeenCalledWith(
      { port: 3443, isHttpsLocal: true },
      expect.objectContaining({ callId: 'call-2' }),
    );
  });

  test('forwards signal and onWaitProgress through to portLock.acquire', async () => {
    const ctx = buildContext('http://localhost:3000');
    const withTunnel = { ...ctx, tunnelId: 'tid-1' };
    const mockAcquire = jest.fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ port: 3000, callId: 'call-3', release: jest.fn() });
    mockGetTunnelInfo.mockReturnValueOnce({ tunnelId: 'tid-1', portLock: { acquire: mockAcquire } });
    const signal = new AbortController().signal;
    const onWaitProgress = jest.fn<(...args: any[]) => Promise<void>>();

    await acquirePortRoute(withTunnel, { callId: 'call-3', signal, onWaitProgress });

    expect(mockAcquire).toHaveBeenCalledWith(
      { port: 3000, isHttpsLocal: false },
      { callId: 'call-3', signal, onWaitProgress },
    );
  });

  test('tunnelId set but TunnelInfo has vanished (evicted mid-flight): throws rather than silently no-op', async () => {
    const ctx = buildContext('http://localhost:3000');
    const withTunnel = { ...ctx, tunnelId: 'tid-gone' };
    mockGetTunnelInfo.mockReturnValueOnce(undefined);

    await expect(acquirePortRoute(withTunnel, { callId: 'call-4' })).rejects.toThrow(/no TunnelInfo/);
  });

  test('portLock.acquire rejects (e.g. CaddyRepointError): propagates, ctx never gets a routeLock', async () => {
    const ctx = buildContext('http://localhost:3000');
    const withTunnel = { ...ctx, tunnelId: 'tid-1' };
    const mockAcquire = jest.fn<(...args: any[]) => Promise<any>>().mockRejectedValue(new Error('repoint failed'));
    mockGetTunnelInfo.mockReturnValueOnce({ tunnelId: 'tid-1', portLock: { acquire: mockAcquire } });

    await expect(acquirePortRoute(withTunnel, { callId: 'call-5' })).rejects.toThrow('repoint failed');
  });
});

describe('releasePortRoute', () => {
  test('ctx with a routeLock: calls release() exactly once', () => {
    const release = jest.fn();
    const ctx = { originalUrl: 'http://localhost:3000', isLocalhost: true, tunnelId: 'tid-1', routeLock: { port: 3000, callId: 'c1', release } };
    releasePortRoute(ctx);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('ctx without a routeLock: no-op, never throws', () => {
    const ctx = buildContext('https://example.com');
    expect(() => releasePortRoute(ctx)).not.toThrow();
  });
});

// ── releaseTunnel ────────────────────────────────────────────────────────────

describe('releaseTunnel', () => {
  test('ctx without tunnelId: stopTunnel NOT called', async () => {
    const ctx = buildContext('https://example.com');
    await releaseTunnel(ctx);
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  test('ctx with tunnelId: calls stopTunnel', async () => {
    const ctx = buildContext('http://localhost:3000');
    mockEnsureSessionTunnel.mockResolvedValueOnce({
      tunnelId: 'tid-1',
      tunnelUrl: 'https://tid-1.ngrok.debugg.ai',
    });
    const enriched = await ensureTunnel(ctx, 'key-1', 'tid-1');

    mockStopTunnel.mockResolvedValueOnce(undefined);
    await releaseTunnel(enriched);
    expect(mockStopTunnel).toHaveBeenCalledWith('tid-1');
  });
});

// ── sanitizeResponseUrls ─────────────────────────────────────────────────────

describe('sanitizeResponseUrls', () => {
  test('non-localhost ctx: returns value unchanged', () => {
    const ctx = buildContext('https://example.com');
    const value = 'Visit https://abc.ngrok.debugg.ai/page';
    expect(sanitizeResponseUrls(value, ctx)).toBe(value);
  });

  test('localhost ctx: replaces ngrok URL with localhost origin in string', () => {
    const ctx = buildContext('http://localhost:3000');
    const value = 'Visit https://abc.ngrok.debugg.ai/page for details';
    const result = sanitizeResponseUrls(value, ctx);
    expect(result).toBe('Visit http://localhost:3000/page for details');
  });

  test('localhost ctx: handles nested object', () => {
    const ctx = buildContext('http://localhost:3000');
    const value = {
      url: 'https://xyz.ngrok.debugg.ai/api',
      nested: {
        link: 'https://xyz.ngrok.debugg.ai/other',
      },
    };
    const result = sanitizeResponseUrls(value, ctx) as any;
    expect(result.url).toBe('http://localhost:3000/api');
    expect(result.nested.link).toBe('http://localhost:3000/other');
  });

  test('localhost ctx: handles array values', () => {
    const ctx = buildContext('http://localhost:3000');
    const value = ['https://abc.ngrok.debugg.ai', 'plain text'];
    const result = sanitizeResponseUrls(value, ctx) as string[];
    expect(result[0]).toBe('http://localhost:3000');
    expect(result[1]).toBe('plain text');
  });

  test('non-string/object/array values pass through', () => {
    const ctx = buildContext('http://localhost:3000');
    expect(sanitizeResponseUrls(42, ctx)).toBe(42);
    expect(sanitizeResponseUrls(null, ctx)).toBeNull();
    expect(sanitizeResponseUrls(true, ctx)).toBe(true);
  });
});
