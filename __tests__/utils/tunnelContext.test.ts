/**
 * Tests for utils/tunnelContext.ts
 *
 * Covers:
 *  - resolveTargetUrl
 *  - buildContext
 *  - ensureTunnel
 *  - releaseTunnel
 *  - sanitizeResponseUrls
 */

import { jest } from '@jest/globals';

// Mock tunnelManager before importing the module under test
const mockProcessUrl = jest.fn<(...args: any[]) => Promise<any>>();
const mockStopTunnel = jest.fn<(...args: any[]) => Promise<any>>();
const mockGetTunnelForPort = jest.fn<(port: number) => any>();
const mockTouchTunnel = jest.fn<(tunnelId: string) => void>();

jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: {
    processUrl: mockProcessUrl,
    stopTunnel: mockStopTunnel,
    getTunnelForPort: mockGetTunnelForPort,
    touchTunnel: mockTouchTunnel,
  },
}));

const {
  resolveTargetUrl,
  buildContext,
  findExistingTunnel,
  ensureTunnel,
  releaseTunnel,
  sanitizeResponseUrls,
} = await import('../../utils/tunnelContext.js');

beforeEach(() => {
  jest.clearAllMocks();
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
  test('public URL: returns null without checking port', () => {
    const ctx = buildContext('https://example.com');
    expect(findExistingTunnel(ctx)).toBeNull();
    expect(mockGetTunnelForPort).not.toHaveBeenCalled();
  });

  test('localhost but no active tunnel: returns null', () => {
    const ctx = buildContext('http://localhost:3000');
    mockGetTunnelForPort.mockReturnValueOnce(undefined);

    expect(findExistingTunnel(ctx)).toBeNull();
    expect(mockGetTunnelForPort).toHaveBeenCalledWith(3000);
    expect(mockTouchTunnel).not.toHaveBeenCalled();
  });

  test('localhost with existing tunnel: returns enriched ctx and touches tunnel', () => {
    const ctx = buildContext('http://localhost:3000');
    mockGetTunnelForPort.mockReturnValueOnce({
      tunnelId: 'existing-t1',
      tunnelUrl: 'https://existing-t1.ngrok.debugg.ai',
      publicUrl: 'https://existing-t1.ngrok.debugg.ai/',
      port: 3000,
    });

    const result = findExistingTunnel(ctx);

    expect(result).not.toBeNull();
    expect(result!.tunnelId).toBe('existing-t1');
    expect(result!.targetUrl).toBe('https://existing-t1.ngrok.debugg.ai/');
    expect(result!.isLocalhost).toBe(true);
    expect(result!.originalUrl).toBe('http://localhost:3000');
    expect(mockTouchTunnel).toHaveBeenCalledWith('existing-t1');
  });

  // Bead zmc9: the cache is keyed by PORT but stores a path-bearing publicUrl from
  // whichever call CREATED the tunnel. Reuse must retarget to the CURRENT caller's
  // path (tunnel origin + this request's path), never replay the creator's path.
  test('zmc9: reuse retargets to the CALLER path, not the creator path baked into publicUrl', () => {
    const ctx = buildContext('http://localhost:3011/dashboard?tab=1#top');
    mockGetTunnelForPort.mockReturnValueOnce({
      tunnelId: 'abc123',
      tunnelUrl: 'https://abc123.ngrok.debugg.ai',
      // creator tunneled a DIFFERENT deep path; this must NOT leak to our caller:
      publicUrl: 'https://abc123.ngrok.debugg.ai/projects/83fa71e2/graphs',
      port: 3011,
    });

    const result = findExistingTunnel(ctx);

    expect(result!.tunnelId).toBe('abc123');
    expect(result!.targetUrl).toBe('https://abc123.ngrok.debugg.ai/dashboard?tab=1#top');
  });

  test('zmc9: a root-path caller does not inherit a cached deep path (the exact repro)', () => {
    const ctx = buildContext('http://localhost:3011/');
    mockGetTunnelForPort.mockReturnValueOnce({
      tunnelId: 'abc123',
      tunnelUrl: 'https://abc123.ngrok.debugg.ai',
      publicUrl: 'https://abc123.ngrok.debugg.ai/projects/83fa71e2/graphs',
      port: 3011,
    });

    const result = findExistingTunnel(ctx);

    expect(result!.targetUrl).toBe('https://abc123.ngrok.debugg.ai/');
  });
});

// ── ensureTunnel ─────────────────────────────────────────────────────────────

describe('ensureTunnel', () => {
  test('non-localhost ctx: returns same ctx, processUrl NOT called', async () => {
    const ctx = buildContext('https://example.com');
    const result = await ensureTunnel(ctx, 'key-1', 'tid-1');
    expect(result).toBe(ctx);
    expect(mockProcessUrl).not.toHaveBeenCalled();
  });

  test('localhost ctx: calls processUrl and returns enriched ctx', async () => {
    const ctx = buildContext('http://localhost:3000');
    mockProcessUrl.mockResolvedValueOnce({
      url: 'https://tid-1.ngrok.debugg.ai',
      tunnelId: 'tid-1',
    });

    const result = await ensureTunnel(ctx, 'key-1', 'tid-1');
    expect(mockProcessUrl).toHaveBeenCalledWith(
      'http://localhost:3000', 'key-1', 'tid-1', undefined, undefined
    );
    expect(result.tunnelId).toBe('tid-1');
    expect(result.targetUrl).toBe('https://tid-1.ngrok.debugg.ai');
    expect(result.originalUrl).toBe('http://localhost:3000');
    expect(result.isLocalhost).toBe(true);
  });

  test('forwards keyId and revokeKey to processUrl', async () => {
    const ctx = buildContext('http://localhost:3000');
    mockProcessUrl.mockResolvedValueOnce({ url: 'https://tid-1.ngrok.debugg.ai', tunnelId: 'tid-1' });
    const revokeKey = jest.fn();

    await ensureTunnel(ctx, 'key-1', 'tid-1', 'kid-1', revokeKey);

    expect(mockProcessUrl).toHaveBeenCalledWith(
      'http://localhost:3000', 'key-1', 'tid-1', 'kid-1', revokeKey
    );
  });

  test('processUrl throws: error propagates', async () => {
    const ctx = buildContext('http://localhost:3000');
    mockProcessUrl.mockRejectedValueOnce(new Error('tunnel failed'));

    await expect(ensureTunnel(ctx, 'key-1', 'tid-1')).rejects.toThrow('tunnel failed');
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
    mockProcessUrl.mockResolvedValueOnce({
      url: 'https://tid-1.ngrok.debugg.ai',
      tunnelId: 'tid-1',
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
