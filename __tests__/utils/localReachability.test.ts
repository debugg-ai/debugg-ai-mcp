/**
 * Tests for localReachability probes (bead 1om).
 *
 * probeLocalPort: spins up a REAL TCP listener and probes it; also probes a
 * freed port to get a genuine ECONNREFUSED. No mocks — these probes are
 * purely net-module mechanics and mocks would hide the real behavior.
 *
 * probeTunnelHealth: uses an injectable fetch so we can cheaply simulate
 * ngrok error bodies / status codes / timeouts / network errors.
 */

import { describe, test, expect, afterEach } from '@jest/globals';
import { createServer, type Server } from 'node:net';
import {
  probeLocalPort,
  probeTunnelHealth,
  extractNgrokErrorCode,
} from '../../utils/localReachability.js';

// ─ probeLocalPort ────────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  // Spin up, grab the OS-assigned port, close — now that port is free but
  // briefly "known free" for probe purposes.
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (typeof addr !== 'object' || !addr) return reject(new Error('no addr'));
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers = [];
});

describe('probeLocalPort', () => {
  test('listening port on 127.0.0.1 → reachable:true', async () => {
    const server = createServer(() => { /* accept no data */ });
    servers.push(server);
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr !== 'object' || !addr) return reject(new Error('no addr'));
        resolve(addr.port);
      });
    });

    const result = await probeLocalPort(port);
    expect(result.reachable).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test('closed port → reachable:false with ECONNREFUSED (fast)', async () => {
    const port = await freePort();

    const start = Date.now();
    const result = await probeLocalPort(port);
    const elapsed = Date.now() - start;

    expect(result.reachable).toBe(false);
    expect(result.code).toBe('ECONNREFUSED');
    expect(elapsed).toBeLessThan(500); // must fail fast, not wait for timeout
  });

  test('unreachable host (blackhole IP) → times out within timeoutMs', async () => {
    // 192.0.2.0/24 is TEST-NET-1 — guaranteed non-routable. Connect attempts
    // hit the timeout rather than getting a fast refused.
    const start = Date.now();
    const result = await probeLocalPort(9999, { host: '192.0.2.1', timeoutMs: 300 });
    const elapsed = Date.now() - start;

    expect(result.reachable).toBe(false);
    expect(result.code).toMatch(/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED/);
    // Should not hang much past timeoutMs — accept up to 2x as slack
    expect(elapsed).toBeLessThan(1500);
  });

  test('server bound to IPv6-only is NOT reachable via default IPv4 host', async () => {
    // This mirrors the exact failure mode from bead fhg: the probe must
    // behave the same way ngrok does (IPv4) so we catch this class of bug
    // before tunneling to ngrok.
    const server = createServer(() => { /* accept */ });
    servers.push(server);
    const port = await new Promise<number>((resolve, reject) => {
      try {
        server.listen(0, '::1', () => {
          const addr = server.address();
          if (typeof addr !== 'object' || !addr) return reject(new Error('no addr'));
          resolve(addr.port);
        });
      } catch (e) { reject(e); }
    });

    const result = await probeLocalPort(port, { timeoutMs: 500 });
    // Default host is 127.0.0.1 — IPv6-only server is unreachable
    expect(result.reachable).toBe(false);
  });

  test('returns elapsedMs for telemetry', async () => {
    const port = await freePort();
    const result = await probeLocalPort(port);
    expect(typeof result.elapsedMs).toBe('number');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

// ─ probeTunnelHealth ─────────────────────────────────────────────────────────

function mockFetch(response: Partial<Response> & { body?: string; status?: number }): typeof fetch {
  return (async () => {
    const body = response.body ?? '';
    const status = response.status ?? 200;
    return new Response(body, { status });
  }) as typeof fetch;
}

function mockFetchThrowing(err: Error): typeof fetch {
  return (async () => { throw err; }) as typeof fetch;
}

describe('extractNgrokErrorCode', () => {
  test('extracts ERR_NGROK_8012 from body', () => {
    expect(extractNgrokErrorCode('<html>ERR_NGROK_8012: failed to dial backend</html>')).toBe('ERR_NGROK_8012');
  });

  test('extracts ERR_NGROK_3200 (generic tunnel error)', () => {
    expect(extractNgrokErrorCode('ERR_NGROK_3200')).toBe('ERR_NGROK_3200');
  });

  test('returns undefined when no marker', () => {
    expect(extractNgrokErrorCode('<html>OK</html>')).toBeUndefined();
    expect(extractNgrokErrorCode('')).toBeUndefined();
  });
});

describe('probeTunnelHealth', () => {
  test('200 response → healthy:true', async () => {
    const r = await probeTunnelHealth('http://example.test', {
      fetchFn: mockFetch({ status: 200, body: '<html>OK</html>' }),
    });
    expect(r.healthy).toBe(true);
    expect(r.status).toBe(200);
  });

  test('4xx from user app → healthy:true (tunnel works, user app 404 is their problem)', async () => {
    const r = await probeTunnelHealth('http://example.test', {
      fetchFn: mockFetch({ status: 404, body: 'Not Found' }),
    });
    expect(r.healthy).toBe(true);
    expect(r.status).toBe(404);
  });

  test('502 + ERR_NGROK_8012 body → healthy:false, NGROK_ERROR with code', async () => {
    const r = await probeTunnelHealth('http://example.test', {
      fetchFn: mockFetch({ status: 502, body: '<html>ERR_NGROK_8012 failed to dial</html>' }),
    });
    expect(r.healthy).toBe(false);
    expect(r.code).toBe('NGROK_ERROR');
    expect(r.ngrokErrorCode).toBe('ERR_NGROK_8012');
    expect(r.detail).toContain('ERR_NGROK_8012');
  });

  test('502 without ngrok marker → healthy:false, BAD_GATEWAY', async () => {
    const r = await probeTunnelHealth('http://example.test', {
      fetchFn: mockFetch({ status: 502, body: 'bare 502' }),
    });
    expect(r.healthy).toBe(false);
    expect(r.code).toBe('BAD_GATEWAY');
    expect(r.status).toBe(502);
  });

  test('504 without ngrok marker → BAD_GATEWAY', async () => {
    const r = await probeTunnelHealth('http://example.test', {
      fetchFn: mockFetch({ status: 504, body: '' }),
    });
    expect(r.healthy).toBe(false);
    expect(r.code).toBe('BAD_GATEWAY');
  });

  test('network error → NETWORK_ERROR', async () => {
    const r = await probeTunnelHealth('http://example.test', {
      fetchFn: mockFetchThrowing(new Error('getaddrinfo ENOTFOUND')),
    });
    expect(r.healthy).toBe(false);
    expect(r.code).toBe('NETWORK_ERROR');
    expect(r.detail).toContain('ENOTFOUND');
  });

  test('timeout (abort) → TIMEOUT', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const r = await probeTunnelHealth('http://example.test', {
      fetchFn: mockFetchThrowing(abortErr),
      timeoutMs: 50,
    });
    expect(r.healthy).toBe(false);
    expect(r.code).toBe('TIMEOUT');
  });

  test('ngrok error even on 200 status → still healthy:false (defensive against weird upstreams)', async () => {
    // Real ngrok returns errors as 502, but if a user's server happens to
    // proxy an ngrok error body at 200 we should still catch it.
    const r = await probeTunnelHealth('http://example.test', {
      fetchFn: mockFetch({ status: 200, body: 'ERR_NGROK_3200' }),
    });
    expect(r.healthy).toBe(false);
    expect(r.code).toBe('NGROK_ERROR');
    expect(r.ngrokErrorCode).toBe('ERR_NGROK_3200');
  });

  test('returns elapsedMs', async () => {
    const r = await probeTunnelHealth('http://example.test', {
      fetchFn: mockFetch({ status: 200, body: 'ok' }),
    });
    expect(typeof r.elapsedMs).toBe('number');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
