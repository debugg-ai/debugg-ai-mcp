/**
 * What to do with a tunnel whose health probe just failed.
 *
 * ngrok bills a MINIMUM OF ONE HOUR PER TUNNEL, so tearing one down and standing
 * a replacement up costs TWO billed hours. A teardown therefore has to be backed
 * by proof that the tunnel is already gone — not by a probe result that a
 * transient edge flake produces just as readily as a real death.
 *
 * All four tool handlers probe tunnel health before handing the URL to the remote
 * browser, and all four used to gate eviction on `health.ngrokErrorCode` being
 * set AT ALL, falling back to stopTunnel() otherwise. Both halves were wrong:
 *
 *   - `ngrokErrorCode` is not a verdict. ERR_NGROK_8012 means the tunnel is ALIVE
 *     and its upstream refused the connection — the tunnel is literally what
 *     served us that error. Evicting on it orphans a live, billing tunnel and
 *     makes the next call provision a replacement: two billed hours spent on a
 *     dev server that was the actual problem.
 *   - the stopTunnel() fallback tore down an OWNED tunnel on ANY probe failure,
 *     including the transient HTTP/2 GOAWAY the ngrok edge sends to undici
 *     (bead k6yq — measured at roughly 1 run in 5 before the retry ladder landed,
 *     and still reachable whenever that ladder exhausts).
 *
 * Hence an explicit allowlist of codes that prove the ENDPOINT ITSELF is gone.
 * Everything else leaves both the tunnel and the shared registry entry completely
 * untouched and just reports TunnelTrafficBlocked: the user fixes their dev
 * server and the next call reuses the same tunnel for free.
 *
 * Bead kmzb, confirmed live on 2026-07-27: probeTunnelHealth cannot currently
 * produce ANY ngrokErrorCode against this edge. `curl` and a raw node:https
 * request both get `404 + ERR_NGROK_3200` from a hostname ngrok no longer routes,
 * but undici's fetch negotiates HTTP/2 and the edge answers with a GOAWAY, which
 * surfaces as UND_ERR_SOCKET / NETWORK_ERROR with no code at all. So in practice
 * every probe failure takes the leave-it-alone branch today. The allowlist is the
 * policy that governs the moment a code CAN be produced — whether that is kmzb
 * forcing HTTP/1.1 for the probe, or a caller passing the marker recorded by a
 * run's own evidence (bead 4bui, the one live-confirmed source of ERR_NGROK_*).
 */

import { tunnelManager } from '../services/ngrok/tunnelManager.js';
import { Logger } from './logger.js';
import type { TunnelHealthProbeResult } from './localReachability.js';

const logger = new Logger({ module: 'tunnelDisposition' });

/**
 * ngrok error codes that PROVE the endpoint no longer exists, so evicting it
 * costs nothing and re-borrowing it costs everyone a failed run (bead k34o).
 *
 * Inclusion criterion — the code must be served BY THE EDGE ABOUT A HOSTNAME IT
 * NO LONGER ROUTES, i.e. it is impossible to receive it from a tunnel that is
 * still up. Anything describing the upstream, the agent, or the connection is a
 * live tunnel reporting on something else, and must NOT be here.
 *
 * Verify a candidate before adding it — the check is free and creates no tunnel:
 *   curl -s https://<random-uuid>.ngrok.debugg.ai/ | grep -o 'ERR_NGROK_[0-9]*'
 * (use curl or node:https, NOT fetch — see the kmzb note above).
 *
 *   ERR_NGROK_3200 — "not found". Verified live 2026-07-27: a GET to a
 *   nonexistent *.ngrok.debugg.ai host returns 404 with this code in the body.
 *   The endpoint is definitively gone; nothing is billing for it.
 *
 * Deliberately EXCLUDED, and the sharpest case of all:
 *
 *   ERR_NGROK_8012 — the agent could not dial the upstream (connection refused).
 *   The TUNNEL IS ALIVE; it is the thing that generated the error page. Evicting
 *   on 8012 orphans a paid-for tunnel and buys a duplicate — two billed hours —
 *   to work around a dev server that is down, bound to the wrong interface, or
 *   still starting up. Leave it be; it will serve the very next request once the
 *   user's server is back.
 *
 * This set is pinned by a test. Adding a code has to be a deliberate act with
 * evidence behind it, not a silent default to teardown.
 *
 * The frozen ARRAY is the source of truth, not a frozen Set: Object.freeze does
 * not make a Set immutable — its entries live in internal slots, so `.add()` on
 * a "frozen" Set still succeeds silently. Freezing the array is a real runtime
 * guarantee; the lookup Set is derived from it and kept private.
 */
const ENDPOINT_GONE_CODES = Object.freeze(['ERR_NGROK_3200']);
const ENDPOINT_GONE_LOOKUP = new Set<string>(ENDPOINT_GONE_CODES);

/** The allowlist, as an immutable list. Read-only by construction. */
export const ENDPOINT_GONE_NGROK_CODES: readonly string[] = ENDPOINT_GONE_CODES;

/**
 * True only when the code proves the endpoint is gone. Unset / unknown codes are
 * NOT proof of anything, so they answer false: the default is always to keep the
 * tunnel we are already paying for.
 */
export function isEndpointGone(ngrokErrorCode?: string): boolean {
  return !!ngrokErrorCode && ENDPOINT_GONE_LOOKUP.has(ngrokErrorCode);
}

/**
 * Decide — once, in one place — what an unhealthy tunnel health probe does to the
 * tunnel. Called by every handler that probes, so the policy cannot drift between
 * them (run_test_suite had already drifted: it evicted on every failure and never
 * got bead k34o's shared-registry eviction at all).
 *
 * Endpoint proven gone  → markTunnelDead: disconnects the tunnel and revokes its
 *                         key. Under the per-session-tunnel model (§4 of
 *                         docs/local-tunnel-multiplexer-architecture-2026-07-31.md)
 *                         every tunnel is created — never borrowed — by this
 *                         process, so there is no separate shared-registry
 *                         adoption record left to evict; bead k34o's borrowed-
 *                         tunnel half retired along with cross-process borrowing.
 * Anything else         → nothing at all. The caller still returns
 *                         TunnelTrafficBlocked, so the user is told; we simply do
 *                         not spend two billed hours acting on a verdict this
 *                         probe cannot actually deliver.
 *
 * Never throws and never awaits the eviction: a cleanup decision must not be able
 * to fail or slow down the error response the caller is about to return.
 */
export function disposeUnhealthyTunnel(args: {
  health: TunnelHealthProbeResult;
  /** Tunnel in play for this request, if one was established. */
  tunnelId?: string;
  /** The caller's original localhost URL. Kept for logging/call-site
   *  compatibility; markTunnelDead(tunnelId) no longer needs a port parsed
   *  out of it (§2.3 — markTunnelDead dropped its `port` parameter now that
   *  eviction is no longer port-scoped). */
  originalUrl: string;
}): void {
  const { health, tunnelId, originalUrl } = args;
  if (!tunnelId) return;

  if (!isEndpointGone(health.ngrokErrorCode)) {
    logger.info(
      `Tunnel ${tunnelId} failed its health probe (${health.code}${health.ngrokErrorCode ? ` ${health.ngrokErrorCode}` : ''}) ` +
      'but nothing proves the endpoint is gone — keeping it. Tearing down a live tunnel costs two billed hours ' +
      '(1-hour minimum down, another up) and the next call reuses this one for free.',
    );
    return;
  }

  logger.warn(
    `Tunnel ${tunnelId} (${originalUrl}) reported ${health.ngrokErrorCode} — the endpoint is gone, evicting it.`,
  );
  tunnelManager.markTunnelDead(tunnelId).catch((err) =>
    logger.warn(`Failed to evict dead tunnel ${tunnelId}: ${err}`),
  );
}
