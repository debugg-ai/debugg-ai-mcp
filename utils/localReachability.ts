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
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

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
  /** Injectable fetch for tests. Defaults to `http1Fetch` — see bead kmzb. */
  fetchFn?: typeof fetch;
  /**
   * Bead k6yq: attempts allowed for TRANSIENT connection-level failures only
   * (see TRANSIENT_CAUSE_CODES). Default 3. Real faults — any HTTP response,
   * connection refused, timeout — are never retried, so this cannot launder a
   * genuine failure into a pass.
   */
  maxAttempts?: number;
  /** Backoff (ms) between transient retries. Default [150, 350]. */
  retryBackoffMs?: number[];
  /** Injectable sleep — test hook. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Bead k6yq: connection-level failures that mean "the edge isn't ready yet",
 * NOT "the tunnel is broken".
 *
 * Measured live on freshly created tunnels against a server serving 200: the
 * ngrok edge sends an HTTP/2 GOAWAY with code 0 (NO_ERROR) — a graceful
 * "reconnect on a fresh connection" signal — which undici raises as
 * UND_ERR_SOCKET behind an opaque "fetch failed". DNS resolved in 1ms, and a
 * retry 250ms later returned 200. Treating that as a fault reported a healthy
 * dev server as unreachable roughly 1 run in 5-14.
 *
 * Deliberately EXCLUDED (these resolve and answer — they are real faults):
 *   ECONNREFUSED / EHOSTUNREACH / ENETUNREACH, TLS errors, any HTTP response
 *   (incl. 502 + ERR_NGROK_*), and timeouts.
 */
const TRANSIENT_CAUSE_CODES = new Set([
  'ENOTFOUND',              // DNS: name not resolvable yet
  'EAI_AGAIN',              // DNS: temporary resolver failure
  'ECONNRESET',             // edge dropped the connection mid-handshake
  'EPIPE',
  // undici codes. Since bead kmzb the default probe transport is node:https,
  // which reports the OS codes above instead — these stay for an injected
  // fetchFn, and as the record of what the HTTP/2 path used to produce.
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * ngrok codes meaning "the edge does not route this hostname".
 *
 * Kept here deliberately separate from tunnelDisposition's ENDPOINT_GONE
 * allowlist even though they currently hold the same code: that list decides
 * whether a verdict may DESTROY a tunnel, this one decides whether a verdict is
 * worth double-checking first. A code could reasonably be on one and not the
 * other, and coupling them would make this module depend on policy it has no
 * business knowing.
 */
const ENDPOINT_NOT_FOUND_CODES = new Set(['ERR_NGROK_3200']);

// ─ HTTP/1.1 probe transport (bead kmzb) ──────────────────────────────────────

/**
 * `fetch`-shaped GET that speaks HTTP/1.1, because the global fetch cannot.
 *
 * Measured against the ngrok edge on 2026-07-27, Node v26:
 *
 *   ALPN offer [h2, http/1.1] → edge selects h2
 *   raw HTTP/2 GET of a hostname ngrok no longer routes
 *       → 404 with ERR_NGROK_3200 in the body, AND a GOAWAY (code 0, NO_ERROR)
 *         on the same connection
 *   undici (global fetch) over that h2 connection
 *       → TypeError: fetch failed / UND_ERR_SOCKET, 3/3 — the response is lost
 *         to the concurrent GOAWAY and never surfaces
 *   node:https (HTTP/1.1)
 *       → 404 + ERR_NGROK_3200, 3/3
 *
 * So the edge was answering us the whole time and undici was dropping the
 * answer. That is why `ngrokErrorCode` had never once been populated in
 * production, which in turn made tunnelDisposition's ENDPOINT_GONE allowlist
 * unreachable: every probe failure looked like a transient network error, and
 * a genuinely dead endpoint could never be told apart from a flake. Speaking
 * HTTP/1.1 makes the distinction observable again and re-activates that
 * allowlist — so ERR_NGROK_3200 can once more evict a tunnel that is provably
 * gone, while everything short of proof still keeps the tunnel we are paying
 * for. It also removes the h2 GOAWAY that bead k6yq's retry ladder existed to
 * paper over, leaving the ladder as a genuine safety net rather than a
 * load-bearing workaround.
 *
 * Node's fetch offers no way to disable h2, hence a transport rather than an
 * option. `http.ClientRequest` — which `https.request` returns — implements
 * HTTP/1.x only, so this cannot regress into h2 no matter what a future Node
 * negotiates by default. The seam is deliberately `typeof fetch` so every
 * caller and test that injects `fetchFn` is unaffected.
 */
export const http1Fetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : (input as Request).url ?? String(input));
  const isPlainHttp = url.protocol === 'http:';
  const signal = init?.signal ?? undefined;

  const options: RequestOptions = {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || (isPlainHttp ? 80 : 443),
    path: `${url.pathname}${url.search}`,
    method: (init?.method ?? 'GET').toUpperCase(),
    headers: (init?.headers as Record<string, string>) ?? {},
    // One-shot probe — do not leave a pooled keep-alive socket behind.
    agent: false,
  };

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const onResponse = (res: IncomingMessage) => {
      if (settled) return;
      settled = true;
      const status = res.statusCode ?? 0;
      // Response rejects a body on these statuses; they have none anyway.
      const bodyless = status === 101 || status === 204 || status === 205 || status === 304;
      if (bodyless) res.resume();
      resolve(
        new Response(bodyless ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
          status,
          headers: headersFrom(res.headers),
        }),
      );
    };

    const req = isPlainHttp
      ? httpRequest(options, onResponse)
      : httpsRequest(options, onResponse);

    if (signal) {
      if (signal.aborted) {
        req.destroy();
        return fail(abortError());
      }
      signal.addEventListener('abort', () => {
        req.destroy();
        fail(abortError());
      }, { once: true });
    }

    req.on('error', fail);
    req.end();
  });
};

/** Matches what an aborted fetch throws, so probeOnce's TIMEOUT arm still fires. */
function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** node:http header bag → Headers, skipping the pseudo/array oddities. */
function headersFrom(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(key, v);
      } catch {
        // A header Headers refuses (invalid name from a hostile server) is not
        // worth failing a health probe over.
      }
    }
  }
  return headers;
}

/** undici hides the real error behind `TypeError: fetch failed` — dig it out. */
function errorCodeOf(err: any): string | undefined {
  return err?.cause?.code ?? err?.code;
}

function isTransientConnectionError(err: any): boolean {
  const code = errorCodeOf(err);
  return code !== undefined && TRANSIENT_CAUSE_CODES.has(code);
}

/**
 * Probe that traffic actually flows through the tunnel.
 *
 * Bead k6yq: a freshly created ngrok tunnel can bounce the first connection
 * (HTTP/2 GOAWAY, DNS not yet resolvable) while being perfectly healthy, so
 * transient connection-level failures are retried with a short backoff. Every
 * other outcome — any HTTP response, connection refused, timeout — is returned
 * on the first attempt, so a real fault is never retried into a false pass.
 */
export async function probeTunnelHealth(
  tunnelUrl: string,
  opts: TunnelHealthProbeOptions = {},
): Promise<TunnelHealthProbeResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const backoff = opts.retryBackoffMs ?? [150, 350];
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();

  let last: TunnelHealthProbeResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { result, retryable } = await probeOnce(tunnelUrl, opts, started);
    if (!retryable) return result;
    last = result;
    if (attempt < maxAttempts) {
      await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 150);
    }
  }
  // Ladder exhausted on a transient error — the edge never came up. Report it:
  // "not ready" that never becomes ready IS unhealthy.
  return last!;
}

async function probeOnce(
  tunnelUrl: string,
  opts: TunnelHealthProbeOptions,
  started: number,
): Promise<{ result: TunnelHealthProbeResult; retryable: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  // Bead kmzb: HTTP/1.1, not the global fetch — see http1Fetch.
  const fetchImpl = opts.fetchFn ?? http1Fetch;
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

    // An ngrok error page. A RESPONSE is proof the edge is up, so these are
    // returned as-is rather than retried into a false pass, and bead 4bui's
    // marker-driven reclassification keeps seeing the real verdict.
    //
    // One exception, and it exists only because bead kmzb made these codes
    // reachable at all: ENDPOINT_NOT_FOUND is the single verdict that
    // AUTHORISES A TEARDOWN (tunnelDisposition's allowlist), and the ngrok
    // agent passes through a short window where it is briefly true — while a
    // dropped session reconnects and re-announces the same hostname. Acting on
    // one sample would kill a tunnel that was about to come back, at a cost of
    // two billed hours. So this code alone is confirmed across the retry
    // ladder: a reconnect resolves inside it, a genuinely deleted endpoint
    // answers the same way every time and is still reported as gone.
    if (ngrokErr) {
      const notFound = ENDPOINT_NOT_FOUND_CODES.has(ngrokErr);
      return {
        retryable: notFound,
        result: {
          healthy: false,
          status: res.status,
          code: 'NGROK_ERROR',
          ngrokErrorCode: ngrokErr,
          detail: notFound
            ? `ngrok returned ${ngrokErr} — the edge no longer routes this tunnel hostname`
            : `ngrok returned ${ngrokErr} — tunnel established but traffic could not reach dev server`,
          elapsedMs: Date.now() - started,
        },
      };
    }
    if (res.status === 502 || res.status === 504) {
      return {
        retryable: false,
        result: {
          healthy: false,
          status: res.status,
          code: 'BAD_GATEWAY',
          detail: `tunnel returned ${res.status} without an ngrok error marker — gateway is rejecting upstream`,
          elapsedMs: Date.now() - started,
        },
      };
    }

    // Any other response (incl. 4xx from user's app) means traffic reached
    // the dev server — that's healthy from the TUNNEL's perspective. The
    // user's 404 is a user concern, not a tunnel concern.
    return {
      retryable: false,
      result: {
        healthy: true,
        status: res.status,
        elapsedMs: Date.now() - started,
      },
    };
  } catch (err) {
    clearTimeout(timer);
    const e = err as any;
    if (e?.name === 'AbortError' || /abort|timeout/i.test(e?.message ?? '')) {
      // Not retried: a hanging tunnel must not cost 3x the timeout budget.
      return {
        retryable: false,
        result: {
          healthy: false,
          code: 'TIMEOUT',
          detail: `tunnel health probe timed out after ${timeoutMs}ms`,
          elapsedMs: Date.now() - started,
        },
      };
    }
    // Surface the cause code: undici reports every network failure as the
    // undiagnosable "fetch failed" and hides the truth in err.cause.
    const causeCode = errorCodeOf(e);
    const baseMsg = e?.message ?? String(err);
    const causeMsg = e?.cause?.message;
    const detail = causeCode
      ? `${baseMsg} (${causeCode}${causeMsg && causeMsg !== baseMsg ? `: ${causeMsg}` : ''})`
      : baseMsg;
    return {
      retryable: isTransientConnectionError(e),
      result: {
        healthy: false,
        code: 'NETWORK_ERROR',
        detail,
        elapsedMs: Date.now() - started,
      },
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
