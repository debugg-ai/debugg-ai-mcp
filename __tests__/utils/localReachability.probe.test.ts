/**
 * Health probing a tunnel goes over the control channel
 * (bead debugg_ai_mcp-xkoh.5.3, requirements xkoh.5.2 R7/R8).
 *
 * A tunnel URL resolves only inside our VPC, so it cannot be fetched from a
 * user's machine at all. The check is a PROBE over the tunnel's own websocket,
 * and its PROBE_RESULT maps onto the TunnelHealthProbeResult the four handlers
 * render — the mapping is pinned on bead debugg_ai_mcp-xkoh.1.2 §9 and is not
 * re-derived here.
 *
 * This is now the ONLY probe path, so this file also inherits the outcomes the
 * deleted HTTP path used to cover (healthy / the user's own 4xx / BAD_GATEWAY /
 * TIMEOUT / NETWORK_ERROR / ladder exhaustion).
 *
 * `forbiddenFetch` is kept as a guard even though `fetchFn` is gone as an
 * option: it proves probeTunnelHealth never reaches for the global fetch either.
 */

import { jest } from '@jest/globals';
import {
  probeTunnelHealth,
  extractTunnelErrorCode,
} from '../../utils/localReachability.js';
import {
  registerControlProbe,
  unregisterControlProbe,
} from '../../services/tunnel/probeRegistry.js';
import type { ProbeResult } from '../../services/tunnel/protocol/index.js';

const TUNNEL_URL = 'https://tid-1.tunnel.debugg.ai/dashboard?a=b';
const HOST = 'tid-1.tunnel.debugg.ai';

/** Installed over the global fetch: probing must never reach for the network. */
const forbiddenFetch = jest.fn(async () => {
  throw new Error('probeTunnelHealth fetched a private tunnel URL instead of using PROBE');
});
const realFetch = globalThis.fetch;
beforeEach(() => { (globalThis as any).fetch = forbiddenFetch; });
afterAll(() => { (globalThis as any).fetch = realFetch; });

function prober(...results: ProbeResult[]) {
  const calls: Array<{ path: string; opts?: { timeoutMs?: number } }> = [];
  let i = 0;
  const fn = jest.fn(async (path: string, opts?: { timeoutMs?: number }) => {
    calls.push({ path, opts });
    return results[Math.min(i++, results.length - 1)];
  });
  return { fn, calls, get callCount() { return i; } };
}

afterEach(() => {
  try { unregisterControlProbe(HOST); } catch { /* stub throws until 4.1 */ }
  jest.clearAllMocks();
});

// ── Markers ──────────────────────────────────────────────────────────────────

describe('extractTunnelErrorCode reads the tunnel server markers', () => {
  // Used twice: on an error page body, and by testPageChangesHandler's
  // findTunnelErrorMarker when it scans a run's own evidence for proof that the
  // remote browser landed on our error page rather than the user's app.
  test('finds DEBUGG_TUNNEL_OFFLINE in a body', () => {
    expect(extractTunnelErrorCode('<h1>Tunnel offline</h1><code>DEBUGG_TUNNEL_OFFLINE</code>'))
      .toBe('DEBUGG_TUNNEL_OFFLINE');
  });

  test('finds DEBUGG_TUNNEL_UPSTREAM_REFUSED', () => {
    expect(extractTunnelErrorCode('error: DEBUGG_TUNNEL_UPSTREAM_REFUSED (502)'))
      .toBe('DEBUGG_TUNNEL_UPSTREAM_REFUSED');
  });

  test('finds DEBUGG_TUNNEL_UNKNOWN', () => {
    expect(extractTunnelErrorCode('DEBUGG_TUNNEL_UNKNOWN')).toBe('DEBUGG_TUNNEL_UNKNOWN');
  });

  test('does NOT find a retired ngrok code — no tunnel we create serves one', () => {
    // Matching them would be dead logic reading as live, and worse: a user's
    // own page mentioning one would get their genuine UI failure reclassified
    // as an infrastructure fault on our side.
    expect(extractTunnelErrorCode('ERR_NGROK_3200 not found')).toBeUndefined();
    expect(extractTunnelErrorCode('<html>ERR_NGROK_8012: failed to dial backend</html>')).toBeUndefined();
  });

  test('returns undefined when there is no marker at all', () => {
    expect(extractTunnelErrorCode('<html>OK</html>')).toBeUndefined();
    expect(extractTunnelErrorCode('')).toBeUndefined();
  });

  test('does NOT match our own env var name — the marker list is explicit, not a prefix match', () => {
    // DEBUGG_TUNNEL_FAULT_MODE is the fault-injection env var
    // (services/tunnel/tunnelFaultInjection.ts). A /DEBUGG_TUNNEL_[A-Z_]+/
    // pattern would read a log line mentioning it as a server marker and
    // reclassify a genuine failure as an infrastructure fault.
    expect(extractTunnelErrorCode('running with DEBUGG_TUNNEL_FAULT_MODE=fail-connect-N:2')).toBeUndefined();
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────

describe('probeTunnelHealth routes a debugg tunnel through PROBE', () => {
  test('uses the registered prober and never fetches the private URL', async () => {
    const p = prober({ status: 200, elapsedMs: 7 });
    registerControlProbe(HOST, p.fn as any);

    const result = await probeTunnelHealth(TUNNEL_URL);

    expect(result.healthy).toBe(true);
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(p.callCount).toBe(1);
  });

  test('probes this caller path and search, not just "/"', async () => {
    const p = prober({ status: 200, elapsedMs: 1 });
    registerControlProbe(HOST, p.fn as any);

    await probeTunnelHealth(TUNNEL_URL);

    expect(p.calls[0].path).toBe('/dashboard?a=b');
  });

  test('a retired ngrok tunnel URL has no control channel, so it reports gone — it is never fetched', async () => {
    // The hostname is still RECOGNISED (so it gets scrubbed out of responses),
    // but this client cannot hold a session for one, and there is no HTTP
    // fallback any more. "Gone" is the honest answer.
    const result = await probeTunnelHealth('https://tid-1.ngrok.debugg.ai/');

    expect(result.healthy).toBe(false);
    expect(result.tunnelErrorCode).toBe('DEBUGG_TUNNEL_UNKNOWN');
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });

  test('a host with no live control channel reports the tunnel gone, and never fetches', async () => {
    // Nothing is registered: this process holds no session for that host, so
    // the tunnel is not coming back on its own. Report it as gone so the
    // disposition evicts the leftover state and the next call re-provisions.
    const result = await probeTunnelHealth(TUNNEL_URL);

    expect(result.healthy).toBe(false);
    expect(result.tunnelErrorCode).toBe('DEBUGG_TUNNEL_UNKNOWN');
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });
});

// ── The mapping (bead xkoh.1.2 §9, verbatim) ─────────────────────────────────

describe('PROBE_RESULT maps onto the existing health codes', () => {
  async function probeWith(...results: ProbeResult[]) {
    const p = prober(...results);
    registerControlProbe(HOST, p.fn as any);
    const result = await probeTunnelHealth(TUNNEL_URL, { retryBackoffMs: [1, 1] });
    return { result, calls: p.callCount };
  }

  test('a status with no marker is healthy — the traffic reached the app', async () => {
    const { result } = await probeWith({ status: 200, elapsedMs: 4 });
    expect(result).toMatchObject({ healthy: true, status: 200 });
  });

  test("the user's own 404 is still healthy from the tunnel's point of view", async () => {
    const { result } = await probeWith({ status: 404, elapsedMs: 4 });
    expect(result.healthy).toBe(true);
  });

  test('502 with no marker is BAD_GATEWAY — the common "dev server is down" case', async () => {
    const { result } = await probeWith({ status: 502, elapsedMs: 4 });
    expect(result).toMatchObject({ healthy: false, code: 'BAD_GATEWAY', status: 502 });
  });

  test('504 with no marker is BAD_GATEWAY', async () => {
    const { result } = await probeWith({ status: 504, elapsedMs: 4 });
    expect(result.code).toBe('BAD_GATEWAY');
  });

  test('a marker becomes TUNNEL_ERROR + tunnelErrorCode, so the disposition policy sees it', async () => {
    const { result } = await probeWith({
      status: 502,
      marker: 'DEBUGG_TUNNEL_UPSTREAM_REFUSED',
      elapsedMs: 9,
    });
    expect(result).toMatchObject({
      healthy: false,
      code: 'TUNNEL_ERROR',
      tunnelErrorCode: 'DEBUGG_TUNNEL_UPSTREAM_REFUSED',
      status: 502,
    });
  });

  test('error TIMEOUT becomes TIMEOUT and is NOT retried — a hanging tunnel must not cost 3x the budget', async () => {
    const { result, calls } = await probeWith({ error: 'TIMEOUT', elapsedMs: 5000 });
    expect(result).toMatchObject({ healthy: false, code: 'TIMEOUT' });
    expect(calls).toBe(1);
  });

  test('any other error becomes NETWORK_ERROR', async () => {
    const { result } = await probeWith({ error: 'CLOSED', elapsedMs: 2 });
    expect(result).toMatchObject({ healthy: false, code: 'NETWORK_ERROR' });
    expect(result.detail).toContain('CLOSED');
  });

  test('elapsedMs is reported for telemetry', async () => {
    const { result } = await probeWith({ status: 200, elapsedMs: 42 });
    expect(typeof result.elapsedMs).toBe('number');
  });

  // Inherited from the deleted HTTP-path suite: a connection-level failure
  // that NEVER clears is still unhealthy. "Not ready" that never becomes ready
  // must not be laundered into a pass by the retry ladder.
  test('a persistent connection-level failure is unhealthy after the ladder, not a pass', async () => {
    const { result, calls } = await probeWith({ error: 'CLOSED', elapsedMs: 2 });
    expect(result.healthy).toBe(false);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(calls).toBe(3);
  });

  // Inherited: a transient failure followed by success IS a pass — the whole
  // point of the ladder (bead k6yq).
  test('a transient failure then a 200 is healthy', async () => {
    const { result, calls } = await probeWith({ error: 'RESET', elapsedMs: 1 }, { status: 200, elapsedMs: 3 });
    expect(result.healthy).toBe(true);
    expect(calls).toBe(2);
  });
});

// ── Teardown-authorising verdicts ────────────────────────────────────────────

describe('OFFLINE is confirmed across the ladder; UNKNOWN is definitive', () => {
  test('a single OFFLINE during a reconnect does not stick — the server holds requests 5s, we re-probe', async () => {
    const p = prober({ marker: 'DEBUGG_TUNNEL_OFFLINE', status: 404, elapsedMs: 3 }, { status: 200, elapsedMs: 3 });
    registerControlProbe(HOST, p.fn as any);

    const result = await probeTunnelHealth(TUNNEL_URL, { retryBackoffMs: [1, 1] });

    expect(result.healthy).toBe(true);
    expect(p.callCount).toBe(2);
  });

  test('a persistent OFFLINE is reported as gone, so a dead tunnel is still evicted', async () => {
    const p = prober({ marker: 'DEBUGG_TUNNEL_OFFLINE', status: 404, elapsedMs: 3 });
    registerControlProbe(HOST, p.fn as any);

    const result = await probeTunnelHealth(TUNNEL_URL, { retryBackoffMs: [1, 1] });

    expect(result.tunnelErrorCode).toBe('DEBUGG_TUNNEL_OFFLINE');
    expect(p.callCount).toBe(3);
  });

  test('UNKNOWN is returned on the first sample — the id is gone, re-probing cannot change that', async () => {
    const p = prober({ marker: 'DEBUGG_TUNNEL_UNKNOWN', status: 404, elapsedMs: 3 });
    registerControlProbe(HOST, p.fn as any);

    const result = await probeTunnelHealth(TUNNEL_URL, { retryBackoffMs: [1, 1] });

    expect(result.tunnelErrorCode).toBe('DEBUGG_TUNNEL_UNKNOWN');
    expect(p.callCount).toBe(1);
  });

  test('UPSTREAM_REFUSED is returned on the first sample — the tunnel served us that page, it is alive', async () => {
    const p = prober({ marker: 'DEBUGG_TUNNEL_UPSTREAM_REFUSED', status: 502, elapsedMs: 3 });
    registerControlProbe(HOST, p.fn as any);

    const result = await probeTunnelHealth(TUNNEL_URL, { retryBackoffMs: [1, 1] });

    expect(result.tunnelErrorCode).toBe('DEBUGG_TUNNEL_UPSTREAM_REFUSED');
    expect(p.callCount).toBe(1);
  });
});
