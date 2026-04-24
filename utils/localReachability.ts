/**
 * Local reachability probes (bead 1om).
 *
 * MCP owns the tunnel lifecycle. It must validate that the user's claimed
 * localhost URL is actually reachable BEFORE calling the backend provision
 * API and BEFORE committing to the slow ngrok/browser-agent path. Without
 * these probes, unreachable apps result in a 5-minute false-positive pass
 * as the browser agent burns its step budget on ERR_NGROK_8012.
 *
 * Two probes:
 *   - probeLocalPort(port): pre-flight TCP connect to 127.0.0.1:<port>
 *   - probeTunnelHealth(url): HTTP check that traffic actually flows through
 *     the tunnel to our local server (catches IPv4/IPv6 bind mismatches,
 *     misconfigured ngrok, etc.)
 */

import { createConnection } from 'node:net';

// ─ Local port probe ──────────────────────────────────────────────────────────

export interface LocalPortProbeResult {
  reachable: boolean;
  /** Standardized reason code when not reachable: ECONNREFUSED, ETIMEDOUT, EHOSTUNREACH, UNKNOWN. */
  code?: string;
  /** Error message for logs / diagnostics. */
  detail?: string;
  /** Elapsed ms — useful for telemetry. */
  elapsedMs: number;
}

export interface LocalPortProbeOptions {
  /** Bind address to try. Defaults to '127.0.0.1' (IPv4) — matches bead fhg's
   *  decision to force IPv4 in ngrok.connect. If a user's server is IPv6-only
   *  this will report not-reachable, which is the right UX (ngrok would fail
   *  the same way). */
  host?: string;
  /** Connect timeout in ms. Default 1500ms — short enough to not add
   *  perceptible latency to the happy path, long enough to tolerate a slow
   *  dev machine. */
  timeoutMs?: number;
}

export async function probeLocalPort(
  port: number,
  opts: LocalPortProbeOptions = {},
): Promise<LocalPortProbeResult> {
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = opts.timeoutMs ?? 1500;
  const started = Date.now();

  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    let settled = false;

    const done = (result: LocalPortProbeResult) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    socket.once('connect', () => {
      done({ reachable: true, elapsedMs: Date.now() - started });
    });

    socket.once('timeout', () => {
      done({
        reachable: false,
        code: 'ETIMEDOUT',
        detail: `connect timeout after ${timeoutMs}ms`,
        elapsedMs: Date.now() - started,
      });
    });

    socket.once('error', (err: NodeJS.ErrnoException) => {
      done({
        reachable: false,
        code: err.code ?? 'UNKNOWN',
        detail: err.message,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

// ─ Tunnel health probe ───────────────────────────────────────────────────────

export interface TunnelHealthProbeResult {
  healthy: boolean;
  /** HTTP status code from the probe, if a response was received. */
  status?: number;
  /** Classified failure reason. */
  code?: 'NGROK_ERROR' | 'BAD_GATEWAY' | 'TIMEOUT' | 'NETWORK_ERROR' | 'UNKNOWN';
  /** ngrok error identifier parsed from body (ERR_NGROK_*) if present. */
  ngrokErrorCode?: string;
  /** Human-readable detail. */
  detail?: string;
  /** Elapsed ms. */
  elapsedMs: number;
}

export interface TunnelHealthProbeOptions {
  /** Request timeout in ms. Default 5000 — tunnels can take a couple seconds
   *  to warm up, but if we can't reach the server in 5s something is wrong. */
  timeoutMs?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export async function probeTunnelHealth(
  tunnelUrl: string,
  opts: TunnelHealthProbeOptions = {},
): Promise<TunnelHealthProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const fetchImpl = opts.fetchFn ?? fetch;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(tunnelUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      // Many user apps reject HEAD; stick to GET for broader compatibility.
      headers: { 'User-Agent': 'debugg-ai-mcp/tunnel-health-probe' },
    });
    clearTimeout(timer);

    // Read body so we can inspect for ngrok error markers. Cap at 4KB —
    // ngrok error pages are small; a full user app body is a waste.
    const bodyText = await readCapped(res, 4096);
    const ngrokErr = extractNgrokErrorCode(bodyText);

    // 502/504 + ngrok error marker → ngrok couldn't reach our server
    if (ngrokErr) {
      return {
        healthy: false,
        status: res.status,
        code: 'NGROK_ERROR',
        ngrokErrorCode: ngrokErr,
        detail: `ngrok returned ${ngrokErr} — tunnel established but traffic could not reach dev server`,
        elapsedMs: Date.now() - started,
      };
    }
    if (res.status === 502 || res.status === 504) {
      return {
        healthy: false,
        status: res.status,
        code: 'BAD_GATEWAY',
        detail: `tunnel returned ${res.status} without an ngrok error marker — gateway is rejecting upstream`,
        elapsedMs: Date.now() - started,
      };
    }

    // Any other response (incl. 4xx from user's app) means traffic reached
    // the dev server — that's healthy from the TUNNEL's perspective. The
    // user's 404 is a user concern, not a tunnel concern.
    return {
      healthy: true,
      status: res.status,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    clearTimeout(timer);
    const e = err as any;
    if (e?.name === 'AbortError' || /abort|timeout/i.test(e?.message ?? '')) {
      return {
        healthy: false,
        code: 'TIMEOUT',
        detail: `tunnel health probe timed out after ${timeoutMs}ms`,
        elapsedMs: Date.now() - started,
      };
    }
    return {
      healthy: false,
      code: 'NETWORK_ERROR',
      detail: e?.message ?? String(err),
      elapsedMs: Date.now() - started,
    };
  }
}

// ─ helpers ───────────────────────────────────────────────────────────────────

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = '';
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const chunk = value.length > remaining ? value.slice(0, remaining) : value;
      out += decoder.decode(chunk, { stream: true });
      total += chunk.length;
      if (value.length > remaining) {
        // Got enough; cancel the rest.
        await reader.cancel().catch(() => { /* ignore */ });
        break;
      }
    }
    out += decoder.decode();
  } catch {
    /* ignore read errors — we return what we have */
  }
  return out;
}

export function extractNgrokErrorCode(body: string): string | undefined {
  // ngrok error pages surface codes like "ERR_NGROK_8012", "ERR_NGROK_3200", etc.
  const match = body.match(/ERR_NGROK_\d+/);
  return match ? match[0] : undefined;
}
