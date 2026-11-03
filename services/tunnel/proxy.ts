/**
 * HTTP(S) proxy support for the debugg tunnel's control websocket
 * (bead platform-neog) and, via the same selection, the REST client
 * (utils/axiosTransport.ts, bead platform-y2ob.3).
 *
 * When HTTPS_PROXY / https_proxy / ALL_PROXY / all_proxy is set and the relay
 * host is not excluded by NO_PROXY / no_proxy, the websocket is opened through
 * an HTTP CONNECT tunnel via https-proxy-agent (handed to `ws` as `agent`).
 * No proxy configured => no agent => the connection is exactly as before.
 *
 * Secrets: the proxy URL may carry user:pass. Only `display` (host:port) is
 * ever put in a message or log; the full URL lives inside the agent.
 */
import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const;

export interface TunnelProxy {
  /** The env var the proxy came from. */
  varName: string;
  /** host:port only — safe to log and show. Never contains credentials. */
  display: string;
  agent: Agent;
}

function defaultPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'wss:' || url.protocol === 'https:' ? 443 : 80;
}

/** curl-style NO_PROXY: comma/space list, `*`, `.suffix`, `*.suffix`, `host`, `host:port`. */
export function noProxyMatches(target: URL, noProxy: string): boolean {
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = defaultPort(target);
  for (const raw of noProxy.split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryPort: number | undefined;
    const m = /^(.*):(\d+)$/.exec(entry);
    if (m && !m[1].includes(':')) {
      entry = m[1];
      entryPort = Number(m[2]);
    }
    if (entryPort !== undefined && entryPort !== port) continue;
    entry = entry.replace(/^\*?\./, '');
    if (!entry) continue;
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

export function resolveTunnelProxy(
  relayUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): TunnelProxy | undefined {
  const varName = PROXY_VARS.find((name) => env[name]?.trim());
  if (!varName) return undefined;

  let target: URL;
  try {
    target = new URL(relayUrl);
  } catch {
    return undefined;
  }
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (noProxy && noProxyMatches(target, noProxy)) return undefined;

  const value = env[varName]!.trim();
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    return undefined;
  }
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') return undefined;
  if (!proxyUrl.hostname) return undefined;

  return {
    varName,
    display: `${proxyUrl.hostname}${proxyUrl.port ? `:${proxyUrl.port}` : ''}`,
    agent: new HttpsProxyAgent(proxyUrl.toString()) as unknown as Agent,
  };
}
