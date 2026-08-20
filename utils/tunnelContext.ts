/**
 * Shared tunnel and URL resolution context used by all MCP tools.
 *
 * Centralizes:
 *  - resolving user input url to a concrete URL
 *  - creating / reusing ngrok tunnels after the backend returns a tunnelKey
 *  - acquiring/releasing this session's shared Caddy port route (§2.4)
 *  - sanitizing backend responses so callers only ever see the original URL
 */

import { tunnelManager, getSessionKey } from '../services/ngrok/tunnelManager.js';
import { isLocalhostUrl, replaceTunnelUrls, retargetTunnelUrl, extractLocalhostPort } from './urlParser.js';
import type { PortRouteHandle, PortWaitInfo } from '../services/caddy/portLock.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TunnelContext {
  /** The URL as the user supplied it (may be localhost). */
  originalUrl: string;
  /** Whether the original URL is localhost / 127.0.0.1. */
  isLocalhost: boolean;
  /** Tunnel ID (ngrok subdomain) used for this request, if a tunnel was created. */
  tunnelId?: string;
  /** The public tunnel URL to pass to the backend as contextData.targetUrl.
   *  For localhost this is the ngrok/Caddy URL; for public URLs it equals originalUrl. */
  targetUrl?: string;
  /** This request's held claim on the session's shared Caddy route (§2.4),
   *  set by `acquirePortRoute` and released via `releasePortRoute`. Undefined
   *  for public URLs, dev-mode calls, and any call that hasn't acquired yet. */
  routeLock?: PortRouteHandle;
}

// ─── URL resolution ──────────────────────────────────────────────────────────

/**
 * Resolve tool input to a concrete URL string.
 */
export function resolveTargetUrl(input: { url: string }): string {
  return input.url;
}

/**
 * Build a TunnelContext for a resolved URL.
 * Call this right after resolving the target URL — before any backend call.
 */
export function buildContext(originalUrl: string): TunnelContext {
  return {
    originalUrl,
    isLocalhost: isLocalhostUrl(originalUrl),
  };
}

// ─── Tunnel creation ─────────────────────────────────────────────────────────

/**
 * Check whether this SESSION already has a tunnel (§2.1 — one ngrok tunnel
 * per session key, not per local port). If found, touches its timer and
 * returns an enriched context retargeted at this caller's own path. Returns
 * null for public URLs or when this session has no tunnel yet.
 *
 * Call this BEFORE provisioning a new key — if it returns a context, skip the provision.
 */
export function findExistingTunnel(ctx: TunnelContext): TunnelContext | null {
  if (!ctx.isLocalhost) return null;
  const existing = tunnelManager.getSessionTunnelInfo(getSessionKey());
  if (!existing) return null;
  tunnelManager.touchTunnel(existing.tunnelId);
  // Bead zmc9: retarget to THIS caller's path — never replay another call's
  // path baked into a previously-returned URL for this same session tunnel.
  return {
    ...ctx,
    tunnelId: existing.tunnelId,
    targetUrl: retargetTunnelUrl(existing.tunnelUrl, ctx.originalUrl),
  };
}

/**
 * Create (or reuse) this session's tunnel (§2.1) for a localhost URL.
 *
 * Call this AFTER the backend returns a `tunnelKey` and `tunnelId`.
 * No-op for public URLs.
 *
 * @param ctx       - Context built from `buildContext()`
 * @param tunnelKey - Auth token from the backend (short-lived ngrok key)
 * @param tunnelId  - ID to use as the ngrok subdomain (only takes effect the
 *                    first time this session creates a tunnel)
 * @param keyId     - Backend key ID; stored on the tunnel so it is revoked on stop
 * @param revokeKey - Callback that revokes the backend key (called when tunnel stops)
 */
export async function ensureTunnel(
  ctx: TunnelContext,
  tunnelKey: string,
  tunnelId: string,
  keyId?: string,
  revokeKey?: () => Promise<void>,
): Promise<TunnelContext> {
  if (!ctx.isLocalhost) return ctx;

  const info = await tunnelManager.ensureSessionTunnel(getSessionKey(), tunnelKey, tunnelId, keyId, revokeKey);
  return { ...ctx, tunnelId: info.tunnelId, targetUrl: retargetTunnelUrl(info.tunnelUrl, ctx.originalUrl) };
}

// ─── Auxiliary caller URLs (bead go1m) ───────────────────────────────────────

/** Outcome of retargeting one caller-supplied auxiliary URL. */
export type AuxUrlRewrite =
  | { ok: true; url: string; rewritten: boolean }
  | { ok: false; reason: 'port_mismatch'; port: number; primaryPort: number };

/**
 * Retarget an auxiliary URL the CALLER supplied (`auth.entryUrl`, `auth.deepUrl`)
 * onto the same tunnel the run's primary `url` already uses.
 *
 * Bead go1m: only the top-level `url` ever went through the localhost→tunnel
 * rewrite. `auth.entryUrl`/`auth.deepUrl` were forwarded verbatim, so a
 * localhost entry URL reached the REMOTE browser as a literal `localhost:PORT`
 * and it dialled its own loopback — `offscope_host` + ERR_CONNECTION_REFUSED on
 * the documented "log in THEN deep-navigate" path. Every URL the run may
 * navigate has to go through the same rewrite as `url`.
 *
 * Three cases, deliberately distinguished:
 *  - not localhost (public URL, or dev mode / no tunnel) → returned unchanged.
 *    Matches how the primary `url` is treated in those same conditions.
 *  - localhost on the SAME port as the primary URL → retargeted onto the
 *    tunnel origin, preserving path + query + hash (`retargetTunnelUrl`).
 *  - localhost on a DIFFERENT port → REFUSED, never silently retargeted. The
 *    session's single Caddy upstream is pointed at the primary URL's port for
 *    the whole call (see `acquirePortRoute`), so rewriting a cross-port URL
 *    onto the same origin would send the login navigation to whichever port
 *    Caddy happens to hold — the silent misdirection the port lock exists to
 *    prevent. Fail fast and tell the caller instead.
 */
export function retargetAuxiliaryUrl(ctx: TunnelContext, auxUrl: string): AuxUrlRewrite {
  // No tunnel in play (public target, or dev mode where the backend reaches
  // localhost directly): the primary URL isn't rewritten either, so neither is this.
  if (!ctx.isLocalhost || !ctx.tunnelId || !ctx.targetUrl) {
    return { ok: true, url: auxUrl, rewritten: false };
  }
  // A public auxiliary URL is reachable by the remote browser as-is.
  if (!isLocalhostUrl(auxUrl)) {
    return { ok: true, url: auxUrl, rewritten: false };
  }
  const port = extractLocalhostPort(auxUrl);
  const primaryPort = extractLocalhostPort(ctx.originalUrl);
  if (port !== undefined && primaryPort !== undefined && port !== primaryPort) {
    return { ok: false, reason: 'port_mismatch', port, primaryPort };
  }
  return { ok: true, url: retargetTunnelUrl(ctx.targetUrl, auxUrl), rewritten: true };
}

// ─── Port route lock (§2.4) ──────────────────────────────────────────────────

/**
 * Acquire this session's shared Caddy route for `ctx`'s port, blocking until
 * Caddy is CONFIRMED pointed at it (§2.4/§3.1 of the architecture doc). Every
 * localhost-targeting handler must call this immediately after
 * `findExistingTunnel`/`ensureTunnel` and BEFORE `probeTunnelHealth` — probing
 * before the repoint is confirmed would probe whatever port happened to be
 * active a moment ago, not the port this call actually wants.
 *
 * No-op (returns `ctx` unchanged) for public URLs and for any ctx that never
 * got a `tunnelId` (dev mode, or a public URL that never provisioned a
 * tunnel) — there is no shared route to serialize in either case.
 */
export async function acquirePortRoute(
  ctx: TunnelContext,
  opts: { callId: string; signal?: AbortSignal; onWaitProgress?: (info: PortWaitInfo) => Promise<void> },
): Promise<TunnelContext> {
  if (!ctx.isLocalhost || !ctx.tunnelId) return ctx;
  const info = tunnelManager.getTunnelInfo(ctx.tunnelId);
  if (!info) {
    throw new Error(`acquirePortRoute: no TunnelInfo for tunnel ${ctx.tunnelId} (session tunnel vanished?)`);
  }
  const port = extractLocalhostPort(ctx.originalUrl);
  if (port === undefined) {
    throw new Error(`acquirePortRoute: could not extract a port from localhost URL: ${ctx.originalUrl}`);
  }
  const isHttpsLocal = ctx.originalUrl.startsWith('https:');
  const routeLock = await info.portLock.acquire({ port, isHttpsLocal }, opts);
  return { ...ctx, routeLock };
}

/**
 * Release this request's claim on the session's shared Caddy route, if it
 * holds one. Call from the handler's existing `finally` block — safe/no-op
 * when `ctx.routeLock` was never set (public URL, dev mode, or the call never
 * reached `acquirePortRoute`).
 */
export function releasePortRoute(ctx: TunnelContext): void {
  ctx.routeLock?.release();
}

/**
 * Stop the tunnel associated with a context (fire-and-forget safe).
 */
export async function releaseTunnel(ctx: TunnelContext): Promise<void> {
  if (ctx.tunnelId) {
    await tunnelManager.stopTunnel(ctx.tunnelId);
  }
}

/**
 * Touch a tunnel's timer by ID to prevent auto-shutoff during active use.
 * Safe to call with undefined (no-op).
 */
export function touchTunnelById(tunnelId?: string): void {
  if (tunnelId) {
    tunnelManager.touchTunnel(tunnelId);
  }
}

// ─── Response sanitization ───────────────────────────────────────────────────

/**
 * Replace any tunnel URLs in a backend response with the original localhost origin.
 * No-op when the original URL was not localhost.
 *
 * Handles nested objects, arrays, and strings recursively.
 */
export function sanitizeResponseUrls(value: unknown, ctx: TunnelContext): unknown {
  if (!ctx.isLocalhost) return value;
  const origin = new URL(ctx.originalUrl).origin;
  return replaceTunnelUrls(value, origin);
}
