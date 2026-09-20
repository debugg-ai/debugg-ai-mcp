/**
 * Health probing a debugg tunnel goes over the control channel
 * (bead debugg_ai_mcp-xkoh.5.3, requirements xkoh.5.2 R7/R8).
 *
 * A debugg tunnel URL resolves only inside our VPC, so probeTunnelHealth's
 * HTTP fetch cannot reach it from a user's machine. For those hosts the check
 * is a PROBE over the tunnel's own websocket, and its PROBE_RESULT maps onto
 * the SAME TunnelHealthProbeResult the four handlers already render — the
 * mapping is pinned on bead debugg_ai_mcp-xkoh.1.2 §9 and is not re-derived
 * here.
 *
 * The result field names stay ngrok-flavoured on purpose (`code:'NGROK_ERROR'`,
 * `ngrokErrorCode`): handlers echo them into tool output, so renaming them
 * would change what callers see. That rename waits for the ngrok deletion step.
 *
 * RED on purpose: probeTunnelHealth always fetches today, and the prober
 * registry is a stub.
 */

import { jest } from '@jest/globals';
import {
  probeTunnelHealth,
  extractNgrokErrorCode,
} from '../../utils/localReachability.js';
import {
  registerControlProbe,
  unregisterControlProbe,
} from '../../services/tunnel/probeRegistry.js';
import type { ProbeResult } from '../../services/tunnel/protocol/index.js';

const TUNNEL_URL = 'https://tid-1.tunnel.debugg.ai/dashboard?a=b';
const HOST = 'tid-1.tunnel.debugg.ai';

/** A fetch that fails the test if the HTTP path is taken for a debugg tunnel. */
const forbiddenFetch = jest.fn(async () => {
  throw new Error('probeTunnelHealth fetched a private tunnel URL instead of using PROBE');
}) as unknown as typeof fetch;

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

describe('extractNgrokErrorCode also reads the debugg markers', () => {
  // Used twice: on an error page body, and by testPageChangesHandler's
  // findNgrokErrorMarker when it scans a run's own evidence for proof that the
  // remote browser landed on our error page rather than the user's app.
  test('finds DEBUGG_TUNNEL_OFFLINE in a body', () => {
    expect(extractNgrokErrorCode('<h1>Tunnel offline</h1><code>DEBUGG_TUNNEL_OFFLINE</code>'))
      .toBe('DEBUGG_TUNNEL_OFFLINE');
  });

  test('finds DEBUGG_TUNNEL_UPSTREAM_REFUSED', () => {
    expect(extractNgrokErrorCode('error: DEBUGG_TUNNEL_UPSTREAM_REFUSED (502)'))
      .toBe('DEBUGG_TUNNEL_UPSTREAM_REFUSED');
  });

  test('finds DEBUGG_TUNNEL_UNKNOWN', () => {
    expect(extractNgrokErrorCode('DEBUGG_TUNNEL_UNKNOWN')).toBe('DEBUGG_TUNNEL_UNKNOWN');
  });

  test('still finds the ngrok codes', () => {
    expect(extractNgrokErrorCode('ERR_NGROK_3200 not found')).toBe('ERR_NGROK_3200');
  });

  test('does NOT match our own env var name — the marker list is explicit, not a prefix match', () => {
    // DEBUGG_TUNNEL_FAULT_MODE is the fault-injection env var
    // (services/ngrok/tunnelFaultInjection.ts). A /DEBUGG_TUNNEL_[A-Z_]+/
    // pattern would read a log line mentioning it as a server marker and
    // reclassify a genuine failure as an infrastructure fault.
    expect(extractNgrokErrorCode('running with DEBUGG_TUNNEL_FAULT_MODE=fail-connect-N:2')).toBeUndefined();
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────

describe('probeTunnelHealth routes a debugg tunnel through PROBE', () => {
  test('uses the registered prober and never fetches the private URL', async () => {
    const p = prober({ status: 200, elapsedMs: 7 });
    registerControlProbe(HOST, p.fn as any);

    const result = await probeTunnelHealth(TUNNEL_URL, { fetchFn: forbiddenFetch });

    expect(result.healthy).toBe(true);
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(p.callCount).toBe(1);
  });

  test('probes this caller path and search, not just "/"', async () => {
    const p = prober({ status: 200, elapsedMs: 1 });
    registerControlProbe(HOST, p.fn as any);

    await probeTunnelHealth(TUNNEL_URL, { fetchFn: forbiddenFetch });

    expect(p.calls[0].path).toBe('/dashboard?a=b');
  });

  test('an ngrok tunnel URL still takes the HTTP path', async () => {
    const fetchFn = jest.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;

    const result = await probeTunnelHealth('https://tid-1.ngrok.debugg.ai/', { fetchFn });

    expect(result.healthy).toBe(true);
    expect(fetchFn).toHaveBeenCalled();
  });

  test('a debugg host with no live control channel reports the tunnel gone, and never fetches', async () => {
    // Nothing is registered: this process holds no session for that host, so
    // the tunnel is not coming back on its own. Report it as gone so the
    // disposition evicts the leftover state and the next call re-provisions.
    const result = await probeTunnelHealth(TUNNEL_URL, { fetchFn: forbiddenFetch });

    expect(result.healthy).toBe(false);
    expect(result.ngrokErrorCode).toBe('DEBUGG_TUNNEL_UNKNOWN');
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });
});

// ── The mapping (bead xkoh.1.2 §9, verbatim) ─────────────────────────────────

describe('PROBE_RESULT maps onto the existing health codes', () => {
  async function probeWith(...results: ProbeResult[]) {
    const p = prober(...results);
    registerControlProbe(HOST, p.fn as any);
    const result = await probeTunnelHealth(TUNNEL_URL, {
      fetchFn: forbiddenFetch,
      retryBackoffMs: [1, 1],
    });
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

  test('a marker becomes NGROK_ERROR + ngrokErrorCode, so the disposition policy sees it', async () => {
    const { result } = await probeWith({
      status: 502,
      marker: 'DEBUGG_TUNNEL_UPSTREAM_REFUSED',
      elapsedMs: 9,
    });
    expect(result).toMatchObject({
      healthy: false,
      code: 'NGROK_ERROR',
      ngrokErrorCode: 'DEBUGG_TUNNEL_UPSTREAM_REFUSED',
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
});

// ── Teardown-authorising verdicts ────────────────────────────────────────────

describe('OFFLINE is confirmed across the ladder; UNKNOWN is definitive', () => {
  test('a single OFFLINE during a reconnect does not stick — the server holds requests 5s, we re-probe', async () => {
    const p = prober({ marker: 'DEBUGG_TUNNEL_OFFLINE', status: 404, elapsedMs: 3 }, { status: 200, elapsedMs: 3 });
    registerControlProbe(HOST, p.fn as any);

    const result = await probeTunnelHealth(TUNNEL_URL, { fetchFn: forbiddenFetch, retryBackoffMs: [1, 1] });

    expect(result.healthy).toBe(true);
    expect(p.callCount).toBe(2);
  });

  test('a persistent OFFLINE is reported as gone, so a dead tunnel is still evicted', async () => {
    const p = prober({ marker: 'DEBUGG_TUNNEL_OFFLINE', status: 404, elapsedMs: 3 });
    registerControlProbe(HOST, p.fn as any);

    const result = await probeTunnelHealth(TUNNEL_URL, { fetchFn: forbiddenFetch, retryBackoffMs: [1, 1] });

    expect(result.ngrokErrorCode).toBe('DEBUGG_TUNNEL_OFFLINE');
    expect(p.callCount).toBe(3);
  });

  test('UNKNOWN is returned on the first sample — the id is gone, re-probing cannot change that', async () => {
    const p = prober({ marker: 'DEBUGG_TUNNEL_UNKNOWN', status: 404, elapsedMs: 3 });
    registerControlProbe(HOST, p.fn as any);

    const result = await probeTunnelHealth(TUNNEL_URL, { fetchFn: forbiddenFetch, retryBackoffMs: [1, 1] });

    expect(result.ngrokErrorCode).toBe('DEBUGG_TUNNEL_UNKNOWN');
    expect(p.callCount).toBe(1);
  });

  test('UPSTREAM_REFUSED is returned on the first sample — the tunnel served us that page, it is alive', async () => {
    const p = prober({ marker: 'DEBUGG_TUNNEL_UPSTREAM_REFUSED', status: 502, elapsedMs: 3 });
    registerControlProbe(HOST, p.fn as any);

    const result = await probeTunnelHealth(TUNNEL_URL, { fetchFn: forbiddenFetch, retryBackoffMs: [1, 1] });

    expect(result.ngrokErrorCode).toBe('DEBUGG_TUNNEL_UPSTREAM_REFUSED');
    expect(p.callCount).toBe(1);
  });
});
