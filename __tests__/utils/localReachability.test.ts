/**
 * Tests for localReachability's LOCAL PORT probe (bead 1om).
 *
 * probeLocalPort spins up a REAL TCP listener and probes it; also probes a
 * freed port to get a genuine ECONNREFUSED. No mocks — these probes are
 * purely net-module mechanics and mocks would hide the real behavior.
 *
 * probeTunnelHealth used to be tested here too, through an injectable `fetch`
 * that simulated ngrok error bodies, statuses, timeouts and undici's HTTP/2
 * flakes. It no longer has an HTTP path to test: a tunnel hostname resolves
 * only inside our VPC, so the health check is a PROBE over the tunnel's own
 * control websocket. Its tests live in localReachability.probe.test.ts, which
 * covers the same outcomes (healthy / the user's own 4xx / BAD_GATEWAY /
 * TIMEOUT / NETWORK_ERROR / markers / the retry ladder) against the mechanism
 * that actually runs.
 */

import { describe, test, expect, afterEach } from '@jest/globals';
import { createServer, type Server } from 'node:net';
import { probeLocalPort } from '../../utils/localReachability.js';

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
    // behave the same way the tunnel's own dial does (IPv4) so we catch this
    // class of bug before opening a tunnel.
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
