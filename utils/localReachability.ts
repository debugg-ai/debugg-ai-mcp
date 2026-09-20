/**
 * Local reachability probes (bead 1om).
 *
 * MCP owns the tunnel lifecycle. It must validate that the user's claimed
 * localhost URL is actually reachable BEFORE calling the backend provision
 * API and BEFORE committing to the slow tunnel/browser-agent path. Without
 * these probes, unreachable apps result in a 5-minute false-positive pass as
 * the browser agent burns its step budget on our upstream-refused error page.
 *
 * Two probes:
 *   - probeLocalPort(port): pre-flight TCP connect to 127.0.0.1:<port>
 *   - probeTunnelHealth(url): asks the tunnel server to fetch the tunnel's own
 *     public URL and report what it got — proof that traffic actually flows
 *     end to end (catches IPv4/IPv6 bind mismatches, a dev server that died
 *     after the port probe, a tunnel that never came up).
 */

import { createConnection } from 'node:net';
import { getControlProbe } from '../services/tunnel/probeRegistry.js';
import type { ProbeResult } from '../services/tunnel/protocol/index.js';

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
   *  decision to force IPv4 on the tunnel's own dial. If a user's server is
   *  IPv6-only this will report not-reachable, which is the right UX (the
   *  tunnel would fail the same way). */
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
  code?: 'TUNNEL_ERROR' | 'BAD_GATEWAY' | 'TIMEOUT' | 'NETWORK_ERROR' | 'UNKNOWN';
  /** The tunnel server's error marker (DEBUGG_TUNNEL_*), if it served one. */
  tunnelErrorCode?: string;
  /** Human-readable detail. */
  detail?: string;
  /** Elapsed ms. */
  elapsedMs: number;
}

export interface TunnelHealthProbeOptions {
  /** Request timeout in ms. Default 5000 — tunnels can take a couple seconds
   *  to warm up, but if we can't reach the server in 5s something is wrong. */
  timeoutMs?: number;
  /**
   * Bead k6yq: attempts allowed for TRANSIENT connection-level failures only.
   * Default 3. Real faults — any HTTP status the app answered with, a timeout,
   * an id the server does not know — are never retried, so this cannot launder
   * a genuine failure into a pass.
   */
  maxAttempts?: number;
  /** Backoff (ms) between transient retries. Default [150, 350]. */
  retryBackoffMs?: number[];
  /** Injectable sleep — test hook. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Markers meaning "the edge does not route this hostname".
 *
 * Kept deliberately separate from tunnelDisposition's ENDPOINT_GONE allowlist
 * even though the codes overlap: that list decides whether a verdict may
 * DESTROY a tunnel, this one decides whether a verdict is worth double-checking
 * first. A code could reasonably be on one and not the other, and coupling them
 * would make this module depend on policy it has no business knowing.
 */
const ENDPOINT_NOT_FOUND_CODES = new Set([
  // The server already holds a browser request for RECONNECT_GRACE_MS (5s)
  // while a client reconnects before rendering this, but a reconnect that
  // outlasts the grace window would otherwise evict a tunnel that is about to
  // come back, so confirm it across the ladder too.
  //
  // DEBUGG_TUNNEL_UNKNOWN is deliberately NOT here: the id is gone, and
  // re-probing cannot change that answer.
  'DEBUGG_TUNNEL_OFFLINE',
]);

/**
 * Probe that traffic actually flows through the tunnel.
 *
 * ONE transport, ONE mechanism: a tunnel hostname resolves only inside our
 * VPC, so it cannot be fetched from the user's machine at all. The health
 * question goes over the tunnel's own control websocket (PROBE /
 * PROBE_RESULT), and the server answers it by making a REAL request back
 * through the public ingress path — same ALB, same nginx, same routing a
 * browser takes. That is strictly better evidence than the client-side HTTP
 * GET this used to do while tunnel URLs were public ngrok hostnames, which is
 * why the HTTP transport (and its `fetchFn` seam, its HTTP/1.1-forcing
 * `http1Fetch`, and the undici-flake retry codes that went with it) went away
 * with ngrok rather than being kept as a fallback: there is nothing left it
 * could reach.
 *
 * Bead k6yq: a freshly created tunnel can bounce the first probe while being
 * perfectly healthy (a session mid-reconnect), so connection-level failures
 * are retried with a short backoff. Every other outcome — any status the app
 * answered with, a timeout, an unknown id — is returned on the first attempt,
 * so a real fault is never retried into a false pass.
 */
export async function probeTunnelHealth(
  tunnelUrl: string,
  opts: TunnelHealthProbeOptions = {},
): Promise<TunnelHealthProbeResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const backoff = opts.retryBackoffMs ?? [150, 350];
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 5000;
  const started = Date.now();

  let last: TunnelHealthProbeResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { result, retryable } = await probeOverControlChannel(tunnelUrl, timeoutMs, started);
    if (!retryable) return result;
    last = result;
    if (attempt < maxAttempts) {
      await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 150);
    }
  }
  // Ladder exhausted on a transient error — the tunnel never came up. Report
  // it: "not ready" that never becomes ready IS unhealthy.
  return last!;
}

// ─ Control-channel probe ─────────────────────────────────────────────────────

/**
 * Ask the tunnel server to fetch `path` back through this tunnel and report
 * what it got. The PROBE_RESULT → TunnelHealthProbeResult mapping is pinned on
 * bead debugg_ai_mcp-xkoh.1.2 §9 and must not be re-derived here.
 */
async function probeOverControlChannel(
  tunnelUrl: string,
  timeoutMs: number,
  started: number,
): Promise<{ result: TunnelHealthProbeResult; retryable: boolean }> {
  const elapsed = () => Date.now() - started;
  const probe = getControlProbe(tunnelUrl);

  if (!probe) {
    // No live control channel in this process for that hostname, and the URL
    // is unreachable any other way. The tunnel is not coming back on its own,
    // so report it gone and let the disposition policy clear the leftovers.
    return {
      retryable: false,
      result: {
        healthy: false,
        code: 'TUNNEL_ERROR',
        tunnelErrorCode: 'DEBUGG_TUNNEL_UNKNOWN',
        detail: 'no live debugg tunnel session in this process for this hostname',
        elapsedMs: elapsed(),
      },
    };
  }

  let probeResult: ProbeResult;
  try {
    probeResult = await probe(probePathOf(tunnelUrl), { timeoutMs });
  } catch (err) {
    // The probe API's contract is that it never throws. Belt and braces: a
    // probe we could not run is not evidence of a fault.
    return {
      retryable: true,
      result: {
        healthy: false,
        code: 'NETWORK_ERROR',
        detail: err instanceof Error ? err.message : String(err),
        elapsedMs: elapsed(),
      },
    };
  }

  const { status, marker, error } = probeResult;

  if (marker) {
    const notFound = ENDPOINT_NOT_FOUND_CODES.has(marker);
    return {
      retryable: notFound,
      result: {
        healthy: false,
        status,
        code: 'TUNNEL_ERROR',
        tunnelErrorCode: marker,
        detail: notFound
          ? `the tunnel server returned ${marker} — no client is connected for this tunnel`
          : `the tunnel server returned ${marker} — tunnel established but traffic could not reach the dev server`,
        elapsedMs: elapsed(),
      },
    };
  }

  if (status !== undefined) {
    if (status === 502 || status === 504) {
      return {
        retryable: false,
        result: {
          healthy: false,
          status,
          code: 'BAD_GATEWAY',
          detail: `tunnel returned ${status} without an error marker — gateway is rejecting upstream`,
          elapsedMs: elapsed(),
        },
      };
    }
    // Any other status means traffic reached the dev server, which is healthy
    // from the TUNNEL's point of view. A user's own 404 is a user concern.
    return { retryable: false, result: { healthy: true, status, elapsedMs: elapsed() } };
  }

  if (error === 'TIMEOUT') {
    // Not retried: a hanging tunnel must not cost three times the timeout
    // budget.
    return {
      retryable: false,
      result: {
        healthy: false,
        code: 'TIMEOUT',
        detail: `tunnel health probe timed out after ${timeoutMs}ms`,
        elapsedMs: elapsed(),
      },
    };
  }

  // Anything else (RESET, CLOSED, ...) is a connection-level failure. It is
  // retried, because a session that is mid-reconnect reports exactly this and
  // recovers within the ladder.
  return {
    retryable: true,
    result: {
      healthy: false,
      code: 'NETWORK_ERROR',
      detail: `tunnel control channel reported ${error ?? 'an unknown failure'}`,
      elapsedMs: elapsed(),
    },
  };
}

/** The path (with search) a probe should request, defaulting to root. */
function probePathOf(tunnelUrl: string): string {
  try {
    const url = new URL(tunnelUrl);
    return `${url.pathname}${url.search}` || '/';
  } catch {
    return '/';
  }
}

// ─ Error markers ─────────────────────────────────────────────────────────────

/**
 * The debugg tunnel server's error markers, spelled out rather than matched by
 * a `DEBUGG_TUNNEL_[A-Z_]+` pattern.
 *
 * A pattern would also match this repo's own `DEBUGG_TUNNEL_FAULT_MODE` env var
 * (services/tunnel/tunnelFaultInjection.ts). This function is used on RUN
 * EVIDENCE as well as on response bodies (testPageChangesHandler's
 * findTunnelErrorMarker), so a log line mentioning that variable would otherwise
 * be read as proof that the browser hit our error page, and a genuine UI
 * failure would be reclassified as an infrastructure fault.
 *
 * ngrok's own error codes used to be matched here too. They went with the
 * ngrok transport: no tunnel this client can create is served by ngrok, so
 * matching them would be dead logic that reads as live — and worse, it would
 * reclassify a genuine app failure as an infrastructure fault if a user's own
 * page ever mentioned one.
 */
const DEBUGG_TUNNEL_MARKERS = Object.freeze([
  'DEBUGG_TUNNEL_OFFLINE',
  'DEBUGG_TUNNEL_UNKNOWN',
  'DEBUGG_TUNNEL_UPSTREAM_REFUSED',
]);

const MARKER_PATTERN = new RegExp(DEBUGG_TUNNEL_MARKERS.join('|'));

/**
 * The stable error marker the tunnel server put in front of the user's app,
 * if any. Handlers echo it into tool output, so it is the one piece of
 * evidence that distinguishes "our tunnel broke" from "the app failed".
 */
export function extractTunnelErrorCode(body: string): string | undefined {
  const match = body.match(MARKER_PATTERN);
  return match ? match[0] : undefined;
}
