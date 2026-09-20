/**
 * What to do with a tunnel whose health probe just failed.
 *
 * A teardown has to be backed by PROOF that the tunnel is already gone — not
 * by a probe result that a transient flake produces just as readily as a real
 * death. Tearing down a live tunnel is not free: the next call has to
 * re-provision, re-handshake and re-point Caddy, and it does that while the
 * user's actual problem (a dev server that is down, bound to the wrong
 * interface, or still starting) is untouched. It converts "your app isn't
 * answering" into "your app isn't answering AND your tunnel churned".
 *
 * (Under ngrok the same rule had a sharper edge — its minimum billing unit was
 * one hour per tunnel, so a needless teardown cost two billed hours. We own
 * the tunnel server now, so the cost is latency and churn rather than money.
 * The policy is unchanged; only the size of the bill is.)
 *
 * All four tool handlers probe tunnel health before handing the URL to the remote
 * browser, and all four used to gate eviction on the error code being set AT ALL,
 * falling back to stopTunnel() otherwise. Both halves were wrong:
 *
 *   - an error code is not a verdict. UPSTREAM_REFUSED means the tunnel is ALIVE
 *     and its upstream refused the connection — the tunnel is literally what
 *     served us that error. Evicting on it orphans a working tunnel and makes
 *     the next call provision a replacement, to work around a dev server that
 *     was the actual problem.
 *   - the stopTunnel() fallback tore down an OWNED tunnel on ANY probe failure,
 *     including a transient connection-level flake (bead k6yq — measured at
 *     roughly 1 run in 5 before the retry ladder landed, and still reachable
 *     whenever that ladder exhausts).
 *
 * Hence an explicit allowlist of codes that prove the ENDPOINT ITSELF is gone.
 * Everything else leaves both the tunnel and the shared registry entry completely
 * untouched and just reports TunnelTrafficBlocked: the user fixes their dev
 * server and the next call reuses the same tunnel.
 */

import { tunnelManager } from '../services/tunnel/tunnelManager.js';
import { Logger } from './logger.js';
import type { TunnelHealthProbeResult } from './localReachability.js';

const logger = new Logger({ module: 'tunnelDisposition' });

/**
 * Tunnel-server error markers that PROVE the endpoint no longer exists, so
 * evicting it costs nothing and keeping it costs the next call a failed run.
 *
 * Inclusion criterion — the marker must be served BY THE EDGE ABOUT A TUNNEL IT
 * CANNOT ROUTE, i.e. it is impossible to receive it from a tunnel that is still
 * up. Anything describing the upstream, the client, or the connection is a live
 * tunnel reporting on something else, and must NOT be here.
 *
 *   DEBUGG_TUNNEL_OFFLINE — no client is connected. Confirmed across
 *     probeTunnelHealth's retry ladder before it gets here, because the server
 *     renders it after a 5s grace window that a slow reconnect can outlast.
 *   DEBUGG_TUNNEL_UNKNOWN — unknown or revoked tunnel id. Definitive.
 *
 * Deliberately EXCLUDED, and the sharpest case of all:
 *
 *   DEBUGG_TUNNEL_UPSTREAM_REFUSED — the client could not dial the local app.
 *   The TUNNEL IS ALIVE; it is the thing that generated the error page.
 *   Evicting on it throws away a working tunnel to work around a dev server
 *   that is down, bound to the wrong interface, or still starting up. Leave it
 *   be; it will serve the very next request once the user's server is back.
 *
 * This set is pinned by a test. Adding a marker has to be a deliberate act with
 * evidence behind it, not a silent default to teardown.
 *
 * The frozen ARRAY is the source of truth, not a frozen Set: Object.freeze does
 * not make a Set immutable — its entries live in internal slots, so `.add()` on
 * a "frozen" Set still succeeds silently. Freezing the array is a real runtime
 * guarantee; the lookup Set is derived from it and kept private.
 */
const ENDPOINT_GONE_CODES = Object.freeze([
  'DEBUGG_TUNNEL_OFFLINE',
  'DEBUGG_TUNNEL_UNKNOWN',
]);
const ENDPOINT_GONE_LOOKUP = new Set<string>(ENDPOINT_GONE_CODES);

/** The allowlist, as an immutable list. Read-only by construction. */
export const ENDPOINT_GONE_TUNNEL_CODES: readonly string[] = ENDPOINT_GONE_CODES;

/**
 * True only when the marker proves the endpoint is gone. Unset / unknown codes are
 * NOT proof of anything, so they answer false: the default is always to keep the
 * tunnel we already have.
 */
export function isEndpointGone(tunnelErrorCode?: string): boolean {
  return !!tunnelErrorCode && ENDPOINT_GONE_LOOKUP.has(tunnelErrorCode);
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
 *                         not tear down a tunnel on a verdict this probe cannot
 *                         actually deliver.
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

  if (!isEndpointGone(health.tunnelErrorCode)) {
    logger.info(
      `Tunnel ${tunnelId} failed its health probe (${health.code}${health.tunnelErrorCode ? ` ${health.tunnelErrorCode}` : ''}) ` +
      'but nothing proves the endpoint is gone — keeping it. Tearing down a live tunnel makes the next ' +
      'call re-provision and re-handshake for nothing, while the next call can reuse this one as is.',
    );
    return;
  }

  logger.warn(
    `Tunnel ${tunnelId} (${originalUrl}) reported ${health.tunnelErrorCode} — the endpoint is gone, evicting it.`,
  );
  tunnelManager.markTunnelDead(tunnelId).catch((err) =>
    logger.warn(`Failed to evict dead tunnel ${tunnelId}: ${err}`),
  );
}
