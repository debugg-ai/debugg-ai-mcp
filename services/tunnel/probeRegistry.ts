/**
 * Control-channel probers, keyed by public tunnel host.
 *
 * Why this exists: debugg tunnel URLs resolve only inside our VPC, so
 * utils/localReachability.ts's probeTunnelHealth cannot fetch them from a
 * user's machine. For those hosts the health check goes over the tunnel's own
 * control websocket (PROBE / PROBE_RESULT) instead, and the server answers by
 * making a real request back through the public ingress path.
 *
 * probeTunnelHealth is a free function that takes nothing but a URL, and it is
 * called from four handlers that hold no transport handle. Rather than thread a
 * new argument through five call sites, debuggTransport registers a prober for
 * the host it just connected and removes it when the tunnel stops; everything
 * else keeps taking the HTTP path unchanged.
 *
 * Module-level state, like the template caches in utils/handlerCaches.ts. It is
 * keyed by hostname, which is globally unique (the tunnel id is a uuid), so two
 * sessions in one process cannot collide.
 */

import type { ProbeResult } from './protocol/index.js';

/** Runs one PROBE over a live control channel. Never throws: a failure is a ProbeResult. */
export type ControlProbe = (path: string, opts?: { timeoutMs?: number }) => Promise<ProbeResult>;

const probes = new Map<string, ControlProbe>();

/** Called by a transport once its control channel is up, for `<id>.tunnel.debugg.ai`. */
export function registerControlProbe(host: string, probe: ControlProbe): void {
  probes.set(normalizeHost(host), probe);
}

/** Called when the tunnel stops for good. Safe to call for an unknown host. */
export function unregisterControlProbe(host: string): void {
  probes.delete(normalizeHost(host));
}

/**
 * The prober for a URL's host, or undefined when this process holds no live
 * control channel for it. Accepts a full URL or a bare host.
 */
export function getControlProbe(url: string): ControlProbe | undefined {
  return probes.get(normalizeHost(url));
}

/** Test hook: forget every registered prober. */
export function _resetControlProbesForTests(): void {
  probes.clear();
}

function normalizeHost(hostOrUrl: string): string {
  if (typeof hostOrUrl !== 'string') return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostOrUrl)) {
    try {
      return new URL(hostOrUrl).hostname.toLowerCase();
    } catch {
      return hostOrUrl.toLowerCase();
    }
  }
  return hostOrUrl.split('/')[0].split(':')[0].toLowerCase();
}
