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

// ─ Bead k6yq: transient-vs-broken ────────────────────────────────────────────
/**
 * probeTunnelHealth returned a FALSE NETWORK_ERROR on a demonstrably healthy
 * server, producing a spurious 'TunnelTrafficBlocked'.
 *
 * The bead hypothesised a DNS race from the ~286ms timing. MEASURED LIVE (14
 * fresh tunnels against a throwaway server serving 200), that is NOT what
 * happens — DNS resolves fine in 1ms. The real failure:
 *
 *   FAIL UND_ERR_SOCKET (HTTP/2: "GOAWAY" frame received with code 0) in 90ms
 *        dns={"ok":true,"address":"2600:1f1c:d8:5f01:...","ms":1}
 *        retry={"ok":true,"status":200,"ms":138}
 *
 * The ngrok edge sends an HTTP/2 GOAWAY with code 0 (NO_ERROR) on a freshly
 * created tunnel — a graceful "reconnect on a new connection" signal. undici
 * surfaces it as UND_ERR_SOCKET behind an opaque "fetch failed", and the probe
 * called a healthy tunnel blocked. A retry 250ms later returns 200.
 *
 * These fakes encode a network layer that is genuinely TRANSIENTLY WRONG (the
 * real, measured misbehaviour). They do not stipulate the probe correct — the
 * probe's own classification is what is under test.
 */

/** The exact undici shape: an opaque "fetch failed" with the truth in .cause. */
function fetchFailed(cause: { code: string; message?: string; syscall?: string }): TypeError {
  const err = new TypeError('fetch failed');
  (err as any).cause = Object.assign(new Error(cause.message ?? cause.code), cause);
  return err;
}

/** Fails the first `failCount` calls with `err`, then serves `status`. */
function mockFetchFlaky(err: Error, failCount: number, status = 200, body = '<html>OK</html>') {
  let calls = 0;
  const fn = (async () => {
    calls++;
    if (calls <= failCount) throw err;
    return new Response(body, { status });
  }) as typeof fetch;
  return { fn, calls: () => calls };
}

const GOAWAY = () => fetchFailed({ code: 'UND_ERR_SOCKET', message: 'HTTP/2: "GOAWAY" frame received with code 0' });
const DNS_MISS = () => fetchFailed({ code: 'ENOTFOUND', syscall: 'getaddrinfo', message: 'getaddrinfo ENOTFOUND x.ngrok.debugg.ai' });
const REFUSED = () => fetchFailed({ code: 'ECONNREFUSED', syscall: 'connect', message: 'connect ECONNREFUSED 1.2.3.4:443' });

const noSleep = async () => { /* keep retry tests instant */ };

describe('probeTunnelHealth — bead k6yq: transient churn vs real fault', () => {
  test('GOAWAY on first attempt then 200 → healthy (the measured live failure)', async () => {
    const flaky = mockFetchFlaky(GOAWAY(), 1);
    const r = await probeTunnelHealth('http://example.test', { fetchFn: flaky.fn, sleepFn: noSleep });

    expect(r.healthy).toBe(true);
    expect(r.status).toBe(200);
    expect(flaky.calls()).toBe(2);
  });

  test('DNS miss on first attempt then resolves → healthy (bead acceptance criterion 1)', async () => {
    const flaky = mockFetchFlaky(DNS_MISS(), 1);
    const r = await probeTunnelHealth('http://example.test', { fetchFn: flaky.fn, sleepFn: noSleep });

    expect(r.healthy).toBe(true);
    expect(flaky.calls()).toBe(2);
  });

  test('two transient failures then 200 → healthy (default ladder tolerates a slow edge)', async () => {
    const flaky = mockFetchFlaky(GOAWAY(), 2);
    const r = await probeTunnelHealth('http://example.test', { fetchFn: flaky.fn, sleepFn: noSleep });

    expect(r.healthy).toBe(true);
    expect(flaky.calls()).toBe(3);
  });

  // ── Do NOT paper over real faults ──────────────────────────────────────────

  test('ECONNREFUSED → unhealthy, and NOT retried (resolves but refused is a real fault)', async () => {
    const flaky = mockFetchFlaky(REFUSED(), 99);
    const r = await probeTunnelHealth('http://example.test', { fetchFn: flaky.fn, sleepFn: noSleep });

    expect(r.healthy).toBe(false);
    expect(r.code).toBe('NETWORK_ERROR');
    expect(r.detail).toContain('ECONNREFUSED');
    expect(flaky.calls()).toBe(1);
  });

  test('502 + ERR_NGROK_8012 → unhealthy NGROK_ERROR on a SINGLE fetch (no retry laundering)', async () => {
    const flaky = mockFetchFlaky(new Error('unused'), 0, 502, '<html>ERR_NGROK_8012 failed to dial</html>');
    const r = await probeTunnelHealth('http://example.test', { fetchFn: flaky.fn, sleepFn: noSleep });

    expect(r.healthy).toBe(false);
    expect(r.code).toBe('NGROK_ERROR');
    expect(r.ngrokErrorCode).toBe('ERR_NGROK_8012');
    expect(flaky.calls()).toBe(1);
  });

  test('502 without marker → unhealthy BAD_GATEWAY on a SINGLE fetch', async () => {
    const flaky = mockFetchFlaky(new Error('unused'), 0, 502, 'bare 502');
    const r = await probeTunnelHealth('http://example.test', { fetchFn: flaky.fn, sleepFn: noSleep });

    expect(r.healthy).toBe(false);
    expect(r.code).toBe('BAD_GATEWAY');
    expect(flaky.calls()).toBe(1);
  });

  test('PERSISTENT transient error → still unhealthy after the ladder (a dead edge is not healthy)', async () => {
    const flaky = mockFetchFlaky(GOAWAY(), 99);
    const r = await probeTunnelHealth('http://example.test', { fetchFn: flaky.fn, sleepFn: noSleep });

    expect(r.healthy).toBe(false);
    expect(r.code).toBe('NETWORK_ERROR');
    expect(flaky.calls()).toBe(3);
  });

  test('PERSISTENT DNS failure → still unhealthy (host that never resolves is not healthy)', async () => {
    const flaky = mockFetchFlaky(DNS_MISS(), 99);
    const r = await probeTunnelHealth('http://example.test', { fetchFn: flaky.fn, sleepFn: noSleep });

    expect(r.healthy).toBe(false);
    expect(r.code).toBe('NETWORK_ERROR');
  });

  test('surfaces the underlying cause code — "fetch failed" alone is undiagnosable', async () => {
    const flaky = mockFetchFlaky(GOAWAY(), 99);
    const r = await probeTunnelHealth('http://example.test', { fetchFn: flaky.fn, sleepFn: noSleep });

    expect(r.detail).toContain('UND_ERR_SOCKET');
  });

  test('timeout is NOT retried — a hanging tunnel must not cost 3x the timeout', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const flaky = mockFetchFlaky(abortErr, 99);
    const r = await probeTunnelHealth('http://example.test', {
      fetchFn: flaky.fn, timeoutMs: 50, sleepFn: noSleep,
    });

    expect(r.code).toBe('TIMEOUT');
    expect(flaky.calls()).toBe(1);
  });
});
