/**
 * TunnelsService tests.
 *
 * Covers:
 *  - provision() happy path with default and custom purpose
 *  - Missing tunnelId / tunnelKey in response
 *  - Transport error classification (bead 5wz): retryable semantics,
 *    diagnostic field extraction (status, code, requestId, networkCode)
 */

import { jest } from '@jest/globals';
import type { TunnelsService } from '../../services/tunnels.js';
import { createTunnelsService, TunnelProvisionError, classifyProvisionError } from '../../services/tunnels.js';

// Mock transport with a post() jest.fn()
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
const mockTx = { post: mockPost } as any;

let service: TunnelsService;

beforeEach(() => {
  jest.clearAllMocks();
  service = createTunnelsService(mockTx);
});

describe('provision()', () => {
  const validResponse = {
    tunnelId: 'tun-123',
    tunnelKey: 'key-abc',
    keyId: 'kid-456',
    expiresAt: '2026-03-01T00:00:00Z',
  };

  test('happy path: POSTs to correct endpoint and returns provision data', async () => {
    mockPost.mockResolvedValue(validResponse);

    const result = await service.provision();

    expect(mockPost).toHaveBeenCalledWith('api/v1/tunnels/', { purpose: 'workflow' });
    expect(result).toEqual({
      tunnelId: 'tun-123',
      tunnelKey: 'key-abc',
      keyId: 'kid-456',
      expiresAt: '2026-03-01T00:00:00Z',
    });
  });

  test('custom purpose: sends provided purpose in body', async () => {
    mockPost.mockResolvedValue(validResponse);

    await service.provision('live_session');

    expect(mockPost).toHaveBeenCalledWith('api/v1/tunnels/', { purpose: 'live_session' });
  });

  test('no args: defaults to "workflow" purpose', async () => {
    mockPost.mockResolvedValue(validResponse);

    await service.provision();

    expect(mockPost).toHaveBeenCalledWith('api/v1/tunnels/', { purpose: 'workflow' });
  });

  test('response missing tunnelId: throws TunnelProvisionError with retryable:false', async () => {
    mockPost.mockResolvedValue({ tunnelKey: 'key-abc', keyId: 'kid-456', expiresAt: '2026-03-01T00:00:00Z' });

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      retryable: false,
      message: expect.stringContaining('missing tunnelId or tunnelKey'),
    });
  });

  test('response missing tunnelKey: throws TunnelProvisionError with retryable:false', async () => {
    mockPost.mockResolvedValue({ tunnelId: 'tun-123', keyId: 'kid-456', expiresAt: '2026-03-01T00:00:00Z' });

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      retryable: false,
    });
  });

  test('response is null: throws TunnelProvisionError with retryable:false', async () => {
    mockPost.mockResolvedValue(null);

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      retryable: false,
    });
  });

  test('transport post() throws: wrapped as TunnelProvisionError with original message preserved', async () => {
    mockPost.mockRejectedValue(new Error('Network error'));

    await expect(service.provision()).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      message: 'Network error',
    });
  });
});

// ─ Bead 5wz: error classification — retryable semantics + diagnostic fields ─
describe('classifyProvisionError', () => {
  test('5xx → retryable:true, status set, request-id extracted from headers', () => {
    const raw = new Error('Service Unavailable') as any;
    raw.statusCode = 503;
    raw.responseData = { detail: 'Service Unavailable', code: 'ngrok_api_down' };
    raw.responseHeaders = { 'x-request-id': 'req-abc-123' };

    const err = classifyProvisionError(raw);

    expect(err).toBeInstanceOf(TunnelProvisionError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
    expect(err.code).toBe('ngrok_api_down');
    expect(err.requestId).toBe('req-abc-123');
    expect(err.diagnosticSuffix()).toBe('(status: 503, code: ngrok_api_down, request-id: req-abc-123, retryable)');
  });

  test('429 rate limit → retryable:true', () => {
    const raw = new Error('Too Many Requests') as any;
    raw.statusCode = 429;

    const err = classifyProvisionError(raw);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
  });

  test('408 request timeout → retryable:true', () => {
    const raw = new Error('Request Timeout') as any;
    raw.statusCode = 408;

    const err = classifyProvisionError(raw);
    expect(err.retryable).toBe(true);
  });

  test('401 auth error → retryable:false (retrying with same key would loop)', () => {
    const raw = new Error('Unauthorized') as any;
    raw.statusCode = 401;

    const err = classifyProvisionError(raw);
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(401);
    expect(err.diagnosticSuffix()).toContain('not-retryable');
  });

  test('403 forbidden → retryable:false', () => {
    const raw = new Error('Forbidden') as any;
    raw.statusCode = 403;

    const err = classifyProvisionError(raw);
    expect(err.retryable).toBe(false);
  });

  test('404 not found → retryable:false', () => {
    const raw = new Error('Not Found') as any;
    raw.statusCode = 404;

    const err = classifyProvisionError(raw);
    expect(err.retryable).toBe(false);
  });

  test('network error (no response, ECONNRESET) → retryable:true, networkCode preserved', () => {
    const raw = new Error('connect ECONNRESET') as any;
    raw.networkCode = 'ECONNRESET';
    // No statusCode → no response received

    const err = classifyProvisionError(raw);
    expect(err.retryable).toBe(true);
    expect(err.status).toBeUndefined();
    expect(err.networkCode).toBe('ECONNRESET');
    expect(err.diagnosticSuffix()).toContain('network: ECONNRESET');
    expect(err.diagnosticSuffix()).toContain('retryable');
  });

  test('unknown non-Error input → retryable:true with default message', () => {
    const err = classifyProvisionError('string error not wrapped');
    expect(err).toBeInstanceOf(TunnelProvisionError);
    expect(err.retryable).toBe(true);
  });

  test('X-Request-Id header casing is tolerated', () => {
    const raw = new Error('err') as any;
    raw.statusCode = 500;
    raw.responseHeaders = { 'X-Request-Id': 'req-xyz' };

    const err = classifyProvisionError(raw);
    expect(err.requestId).toBe('req-xyz');
  });

  test('diagnostic suffix omits null fields', () => {
    const raw = new Error('minimal') as any;
    raw.statusCode = 500;
    // no code, no requestId, no networkCode

    const err = classifyProvisionError(raw);
    expect(err.diagnosticSuffix()).toBe('(status: 500, retryable)');
  });
});

// ─ Bead 7nx: retry with exponential backoff on retryable failures ───────────
describe('provisionWithRetry()', () => {
  const validResponse = {
    tunnelId: 'tun-ok',
    tunnelKey: 'key-ok',
    keyId: 'kid-ok',
    expiresAt: '2026-03-01T00:00:00Z',
  };

  function build5xxError(status = 503): any {
    const e = new Error('Service Unavailable') as any;
    e.statusCode = status;
    return e;
  }

  function build4xxAuthError(): any {
    const e = new Error('Unauthorized') as any;
    e.statusCode = 401;
    return e;
  }

  test('first attempt succeeds → no retry, no sleep', async () => {
    mockPost.mockResolvedValueOnce(validResponse);
    const sleepSpy = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    const result = await service.provisionWithRetry({ sleepFn: sleepSpy });

    expect(result.tunnelId).toBe('tun-ok');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('transient 503 then success: retries once, succeeds on attempt 2, sleeps with first backoff', async () => {
    mockPost
      .mockRejectedValueOnce(build5xxError(503))
      .mockResolvedValueOnce(validResponse);
    const sleepSpy = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    const result = await service.provisionWithRetry({
      sleepFn: sleepSpy,
      backoffMs: [10, 20, 30],
    });

    expect(result.tunnelId).toBe('tun-ok');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(10);
  });

  test('all 3 attempts fail with 503: throws the last classified error with retryable:true', async () => {
    mockPost.mockRejectedValue(build5xxError(503));
    const sleepSpy = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    await expect(
      service.provisionWithRetry({ sleepFn: sleepSpy, backoffMs: [1, 1, 1] }),
    ).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      status: 503,
      retryable: true,
    });

    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2); // N-1 sleeps for N attempts
  });

  test('401 auth error: fails fast, no retry, no sleep (retrying with same key would loop)', async () => {
    mockPost.mockRejectedValue(build4xxAuthError());
    const sleepSpy = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    await expect(
      service.provisionWithRetry({ sleepFn: sleepSpy }),
    ).rejects.toMatchObject({
      name: 'TunnelProvisionError',
      status: 401,
      retryable: false,
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('network error → retryable → retries', async () => {
    const networkErr = new Error('connect ECONNRESET') as any;
    networkErr.networkCode = 'ECONNRESET';
    mockPost
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce(validResponse);
    const sleepSpy = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    const result = await service.provisionWithRetry({ sleepFn: sleepSpy, backoffMs: [5] });

    expect(result.tunnelId).toBe('tun-ok');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledWith(5);
  });

  test('maxAttempts:1 → single attempt, no retry even if retryable', async () => {
    mockPost.mockRejectedValue(build5xxError(503));
    const sleepSpy = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    await expect(
      service.provisionWithRetry({ maxAttempts: 1, sleepFn: sleepSpy }),
    ).rejects.toMatchObject({ name: 'TunnelProvisionError' });

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('custom purpose is forwarded to provision on every attempt', async () => {
    mockPost
      .mockRejectedValueOnce(build5xxError(503))
      .mockResolvedValueOnce(validResponse);
    const sleepSpy = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    await service.provisionWithRetry({
      purpose: 'live_session',
      sleepFn: sleepSpy,
      backoffMs: [1],
    });

    expect(mockPost).toHaveBeenNthCalledWith(1, 'api/v1/tunnels/', { purpose: 'live_session' });
    expect(mockPost).toHaveBeenNthCalledWith(2, 'api/v1/tunnels/', { purpose: 'live_session' });
  });

  test('backoff: attempts sleep with the i-th backoff value (500ms default schedule)', async () => {
    mockPost.mockRejectedValue(build5xxError(503));
    const sleepSpy = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    await expect(
      service.provisionWithRetry({ sleepFn: sleepSpy }), // default backoff [500, 1500, 3000]
    ).rejects.toMatchObject({ name: 'TunnelProvisionError' });

    // 3 attempts, 2 sleeps between them → schedule[0]=500, schedule[1]=1500
    expect(sleepSpy.mock.calls.map((c) => c[0])).toEqual([500, 1500]);
  });
});
