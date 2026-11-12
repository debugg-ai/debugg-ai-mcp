/**
 * Extra local origins a run may be redirected to (bead w1os.2). Kept out of
 * tunnelContext.ts so handler tests that mock that module are unaffected.
 */
import { tunnelManager } from '../services/tunnel/tunnelManager.js';
import type { AuxOrigin } from '../services/caddy/caddyProxy.js';
import { extractLocalhostPort } from './urlParser.js';
import type { TunnelContext } from './tunnelContext.js';


const EXTRA_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal']);

export class ExtraOriginError extends Error {
  constructor(public readonly origin: string, reason: string) {
    super(`extraOrigins entry "${origin}" ${reason}`);
    this.name = 'ExtraOriginError';
  }
}

/** Parse `4304`, `localhost:4304`, or `http(s)://host.docker.internal:4717[/…]`. */
export function parseExtraOrigin(raw: string): AuxOrigin {
  const t = raw.trim();
  if (/^\d+$/.test(t)) {
    const port = Number(t);
    if (port < 1 || port > 65535) throw new ExtraOriginError(raw, 'is not a valid port');
    return { port };
  }
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`);
  } catch {
    throw new ExtraOriginError(raw, 'is not a URL, host:port, or port');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ExtraOriginError(raw, 'must be http or https');
  if (!EXTRA_ORIGIN_HOSTS.has(u.hostname.toLowerCase())) {
    throw new ExtraOriginError(raw, 'must be localhost, 127.0.0.1, [::1] or host.docker.internal');
  }
  const isHttpsLocal = u.protocol === 'https:';
  const port = u.port ? Number(u.port) : isHttpsLocal ? 443 : 80;
  return { port, ...(isHttpsLocal ? { isHttpsLocal: true } : {}) };
}

/**
 * Authorise the caller's extra origins on this session's Caddy and record them
 * on the context. Call after `acquirePortRoute`. No-op without a tunnel.
 */
export async function authorizeExtraOrigins(ctx: TunnelContext, raw: string[] | undefined): Promise<TunnelContext> {
  if (!raw || raw.length === 0 || !ctx.isLocalhost || !ctx.tunnelId) return ctx;
  const primaryPort = extractLocalhostPort(ctx.originalUrl);
  const origins = raw.map(parseExtraOrigin).filter((o) => o.port !== primaryPort);
  if (origins.length === 0) return ctx;
  const info = tunnelManager.getTunnelInfo(ctx.tunnelId);
  if (!info) throw new Error(`authorizeExtraOrigins: no TunnelInfo for tunnel ${ctx.tunnelId}`);
  await info.caddy.addAuxOrigins(origins);
  return { ...ctx, extraOrigins: origins };
}

