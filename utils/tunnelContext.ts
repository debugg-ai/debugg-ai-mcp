/**
 * Shared tunnel and URL resolution context used by all MCP tools.
 *
 * Centralizes:
 *  - resolving user input (url / localPort) to a concrete URL
 *  - creating / reusing ngrok tunnels after the backend returns a tunnelKey
 *  - sanitizing backend responses so callers only ever see the original URL
 */

import { tunnelManager } from '../services/ngrok/tunnelManager.js';
import { isLocalhostUrl, replaceTunnelUrls } from './urlParser.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TunnelContext {
  /** The URL as the user supplied it (may be localhost). */
  originalUrl: string;
  /** Whether the original URL is localhost / 127.0.0.1. */
  isLocalhost: boolean;
  /** Tunnel ID (ngrok subdomain) used for this request, if a tunnel was created. */
  tunnelId?: string;
}

// ─── URL resolution ──────────────────────────────────────────────────────────

/**
 * Resolve tool input to a concrete URL string.
 * Accepts either a `url` string or a `localPort` number; throws if neither provided.
 */
export function resolveTargetUrl(input: { url?: string; localPort?: number }): string {
  if (input.url) return input.url;
  if (input.localPort) return `http://localhost:${input.localPort}`;
  throw new Error(
    'Provide a target URL via "url" (e.g. "https://example.com") ' +
    'or "localPort" for a local dev server.'
  );
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
 * Create (or reuse) a tunnel for a localhost URL.
 *
 * Call this AFTER the backend returns a `tunnelKey` and `tunnelId`
 * (e.g. executionUuid from executeWorkflow, sessionId from startSession).
 *
 * No-op and returns null for public URLs.
 *
 * @param ctx       - Context built from `buildContext()`
 * @param tunnelKey - Auth token from the backend (short-lived ngrok key)
 * @param tunnelId  - ID to use as the ngrok subdomain (must match what the backend expects)
 */
export async function ensureTunnel(
  ctx: TunnelContext,
  tunnelKey: string,
  tunnelId: string
): Promise<TunnelContext> {
  if (!ctx.isLocalhost) return ctx;

  const result = await tunnelManager.processUrl(ctx.originalUrl, tunnelKey, tunnelId);
  return { ...ctx, tunnelId: result.tunnelId };
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
