/**
 * Local ngrok agent inspector (bead lc62).
 *
 * Every ngrok agent process serves a local inspection API on 127.0.0.1:4040,
 * incrementing to 4041, 4042, ... when the port is taken. `GET /api/tunnels`
 * answers with the tunnels THAT AGENT currently has open:
 *
 *   {"tunnels":[{"public_url":"https://x.ngrok.debugg.ai",
 *                "config":{"addr":"http://127.0.0.1:3011"}}],"uri":"/api/tunnels"}
 *
 * This is the only free, honest source of tunnel liveness we have. It is
 * loopback: no DNS, no TLS, no ngrok edge, no undici, and — critically — no
 * request to the tunnel's PUBLIC url. Probing the public url for a reuse
 * decision is the k6yq / z15n / kmzb failure class: the edge answers undici
 * over HTTP/2 and the response is lost to a concurrent GOAWAY, so a live tunnel
 * reads as dead and gets replaced for two billed hours.
 *
 * ── The safety property, and why it is structural rather than a policy ──
 *
 * A tunnel MISSING from this API is not proof it is gone: the agent that owns
 * it may be on a port we did not scan, or may not be answering. Only a
 * REACHABLE agent that does not list a tunnel is evidence, and even that is
 * scoped to that one agent.
 *
 * Rather than encode that asymmetry as a tri-state ("live" / "gone" /
 * "unknown") that some future caller could mishandle, the inspector returns
 * only what it POSITIVELY OBSERVED, and TunnelManager uses it in an
 * ADD-ONLY way: reconciliation can create or refresh a registry entry, never
 * delete one. An unreachable agent therefore contributes an empty list and
 * changes nothing versus today's behaviour, and no failure of this module can
 * ever cost a re-provision. That is a guarantee about the shape of the data
 * flow, not a rule someone has to remember.
 *
 * Adoption is filtered to `*.ngrok.debugg.ai`. A developer's own unrelated
 * ngrok tunnels share this agent API and must never be touched by us.
 */

import { request as httpRequest } from 'node:http';
import { Logger } from '../../utils/logger.js';
import { getFaultModeFromEnv, type FaultMode } from './tunnelFaultInjection.js';

const logger = new Logger({ module: 'ngrokAgentInspector' });

/** Only tunnels on this suffix are ours to adopt. */
const OWNED_TUNNEL_SUFFIX = '.ngrok.debugg.ai';

/** ngrok's web-inspector base port, and how far it walks when 4040 is busy. */
const FIRST_INSPECTOR_PORT = 4040;
const INSPECTOR_PORT_COUNT = 10;

/** A tunnel a local ngrok agent says it currently has open. */
export interface LiveAgentTunnel {
  /** ngrok subdomain — the same value TunnelManager uses as tunnelId. */
  tunnelId: string;
  /** Origin as the agent reports it, e.g. `https://x.ngrok.debugg.ai`. */
  publicUrl: string;
  /** The local port the tunnel forwards to, parsed from `config.addr`. */
  port: number;
}

export interface TunnelInspector {
  /**
   * Tunnels POSITIVELY OBSERVED on this machine's ngrok agents.
   *
   * Never throws and never rejects: an unreachable agent, a malformed body, or
   * a version bump that moves the API all answer with an empty list, which
   * callers must treat as "learned nothing" — never as "nothing is alive".
   */
  listLiveTunnels(): Promise<LiveAgentTunnel[]>;
}

export interface LocalAgentInspectorOptions {
  /** Inspector ports to scan. Defaults to 4040..4049. */
  ports?: number[];
  /** Per-agent request timeout. Loopback, so this is generous. */
  timeoutMs?: number;
  /** Injectable fetch of one agent's raw /api/tunnels body — test hook. */
  fetchAgentTunnels?: (port: number, timeoutMs: number) => Promise<string | undefined>;
  /** Fault modes (bead 42g). Defaults to the DEBUGG_TUNNEL_FAULT_MODE env var. */
  faultMode?: FaultMode | null;
}

/**
 * Parse one agent's `/api/tunnels` body into the tunnels we are allowed to own.
 *
 * Tolerant by construction — every unexpected shape drops the entry rather than
 * throwing, because a parse failure must degrade to "learned nothing".
 *
 * ngrok reports the same tunnel more than once when it exposes several protos,
 * so results are de-duplicated by tunnelId; first hostname wins.
 */
export function parseAgentTunnels(body: string): LiveAgentTunnel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const raw = (parsed as { tunnels?: unknown })?.tunnels;
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: LiveAgentTunnel[] = [];
  for (const item of raw) {
    const publicUrl = (item as { public_url?: unknown })?.public_url;
    const addr = (item as { config?: { addr?: unknown } })?.config?.addr;
    if (typeof publicUrl !== 'string' || typeof addr !== 'string') continue;

    const tunnelId = tunnelIdFromPublicUrl(publicUrl);
    if (!tunnelId || seen.has(tunnelId)) continue;

    const port = portFromAgentAddr(addr);
    if (port === undefined) continue;

    seen.add(tunnelId);
    out.push({ tunnelId, publicUrl, port });
  }
  return out;
}

/**
 * Subdomain of a `*.ngrok.debugg.ai` public url, or undefined for anything
 * else — including a developer's personal ngrok tunnels, which share this
 * agent API and are none of our business.
 */
function tunnelIdFromPublicUrl(publicUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(publicUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host.endsWith(OWNED_TUNNEL_SUFFIX)) return undefined;
  const sub = host.slice(0, -OWNED_TUNNEL_SUFFIX.length);
  // A bare or multi-label subdomain is not a tunnelId we minted.
  return sub && !sub.includes('.') ? sub : undefined;
}

/**
 * Local port out of an agent `config.addr`, which ngrok reports in several
 * shapes depending on how connect() was called: `http://127.0.0.1:3011`,
 * `https://localhost:3443`, or a bare `localhost:3011`.
 */
export function portFromAgentAddr(addr: string): number | undefined {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(addr) ? addr : `tcp://${addr}`;
  try {
    const port = new URL(withScheme).port;
    if (port) {
      const n = Number(port);
      return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/**
 * GET one agent's /api/tunnels over loopback HTTP/1.1.
 *
 * `agent: false` so the socket is closed rather than pooled — this runs once
 * per process and must not leave a keep-alive handle behind.
 */
function fetchAgentTunnelsOverHttp(port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value?: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/tunnels', method: 'GET', agent: false, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return done(undefined);
        }
        let body = '';
        res.setEncoding('utf8');
        // 256KB ceiling: something answering on 4040 that is not an ngrok agent
        // must not be able to stream us out of memory.
        res.on('data', (chunk: string) => {
          if (body.length < 262144) body += chunk;
        });
        res.on('end', () => done(body));
        res.on('error', () => done(undefined));
      },
    );
    req.on('timeout', () => { req.destroy(); done(undefined); });
    // Nothing is listening on most of these ports; ECONNREFUSED is the norm.
    req.on('error', () => done(undefined));
    req.end();
  });
}

/**
 * Scans the local agents. Ports are probed in parallel — nearly all of them
 * refuse instantly, so the wall cost is one timeout at worst.
 */
export function createLocalAgentInspector(opts: LocalAgentInspectorOptions = {}): TunnelInspector {
  const ports =
    opts.ports ?? Array.from({ length: INSPECTOR_PORT_COUNT }, (_, i) => FIRST_INSPECTOR_PORT + i);
  const timeoutMs = opts.timeoutMs ?? 500;
  const fetchOne = opts.fetchAgentTunnels ?? fetchAgentTunnelsOverHttp;

  return {
    async listLiveTunnels(): Promise<LiveAgentTunnel[]> {
      const faults = opts.faultMode !== undefined ? opts.faultMode : getFaultModeFromEnv();
      if (faults?.inspectorUnreachable) {
        logger.debug('[fault-inject] ngrok agent inspector forced unreachable');
        return [];
      }
      if (faults?.inspectorAdoptPort !== undefined) {
        const port = faults.inspectorAdoptPort;
        logger.debug(`[fault-inject] ngrok agent inspector reporting a synthetic tunnel on port ${port}`);
        return [{
          tunnelId: `fault-adopt-${port}`,
          publicUrl: `https://fault-adopt-${port}${OWNED_TUNNEL_SUFFIX}`,
          port,
        }];
      }

      const bodies = await Promise.all(
        ports.map((port) => fetchOne(port, timeoutMs).catch(() => undefined)),
      );

      const seen = new Set<string>();
      const found: LiveAgentTunnel[] = [];
      for (const body of bodies) {
        if (!body) continue;
        for (const tunnel of parseAgentTunnels(body)) {
          if (seen.has(tunnel.tunnelId)) continue;
          seen.add(tunnel.tunnelId);
          found.push(tunnel);
        }
      }
      return found;
    },
  };
}

/** Learns nothing, ever. The default under NODE_ENV=test. */
export const noopInspector: TunnelInspector = {
  listLiveTunnels: async () => [],
};

/**
 * Mirrors getDefaultRegistry(): tests get the inert inspector so no unit test
 * can reach the network, production gets the real loopback scan.
 */
export function getDefaultInspector(): TunnelInspector {
  return process.env.NODE_ENV === 'test' ? noopInspector : createLocalAgentInspector();
}
