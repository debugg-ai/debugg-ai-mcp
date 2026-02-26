/**
 * Shared tunnel and URL resolution context used by all MCP tools.
 *
 * Centralizes:
 *  - resolving user input url to a concrete URL
 *  - creating / reusing ngrok tunnels after the backend returns a tunnelKey
 *  - sanitizing backend responses so callers only ever see the original URL
 */

import { tunnelManager } from '../services/ngrok/tunnelManager.js';
import { isLocalhostUrl, replaceTunnelUrls, extractLocalhostPort } from './urlParser.js';

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
 * Check whether an active tunnel already exists for the same local port.
 * If found, touches its timer and returns an enriched context pointing at it.
 * Returns null for public URLs or when no tunnel is active for that port.
 *
 * Call this BEFORE provisioning a new key — if it returns a context, skip the provision.
 */
export function findExistingTunnel(ctx: TunnelContext): TunnelContext | null {
  if (!ctx.isLocalhost) return null;
  const port = extractLocalhostPort(ctx.originalUrl);
  if (!port) return null;
  const existing = tunnelManager.getTunnelForPort(port);
  if (!existing) return null;
  tunnelManager.touchTunnel(existing.tunnelId);
  return { ...ctx, tunnelId: existing.tunnelId, targetUrl: existing.publicUrl };
}

/**
 * Create (or reuse) a tunnel for a localhost URL.
 *
 * Call this AFTER the backend returns a `tunnelKey` and `tunnelId`.
 * No-op for public URLs.
 *
 * @param ctx       - Context built from `buildContext()`
 * @param tunnelKey - Auth token from the backend (short-lived ngrok key)
 * @param tunnelId  - ID to use as the ngrok subdomain
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

  const result = await tunnelManager.processUrl(ctx.originalUrl, tunnelKey, tunnelId, keyId, revokeKey);
  return { ...ctx, tunnelId: result.tunnelId, targetUrl: result.url };
}

/**
 * Stop the tunnel associated with a context (fire-and-forget safe).
 */
export async function releaseTunnel(ctx: TunnelContext): Promise<void> {
  if (ctx.tunnelId) {
    await tunnelManager.stopTunnel(ctx.tunnelId);
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
