/**
 * The hostnames a tunnel can live on, and which transport serves each one.
 *
 * During the migration a single MCP process can hold an ngrok tunnel and a
 * debugg tunnel at the same time, so every place that recognises a tunnel
 * hostname has to know both. The one that matters to users is
 * `replaceTunnelUrls`: it is what keeps a tunnel hostname out of every tool
 * response, so a domain it does not know is a URL that leaks to the caller.
 *
 * A provision response may name a domain we do not ship (the backend moving
 * `tunnel.debugg.ai` elsewhere, or a staging host), so domains can be
 * registered at runtime — that is what lets the server move without an MCP
 * release, the same reasoning as `relayUrl`.
 *
 * Imports NOTHING, deliberately: utils/urlParser.ts, utils/localReachability.ts
 * and services/ngrok/tunnelManager.ts all depend on it, and it must never be
 * the module that creates a cycle.
 */

/** Which transport serves a domain. A provision response with no `transport` means ngrok. */
export type TunnelTransportKind = 'ngrok' | 'debugg';

export interface TunnelDomainInfo {
  domain: string;
  transport: TunnelTransportKind;
}

const BUILT_IN_DOMAINS: ReadonlyArray<TunnelDomainInfo> = Object.freeze([
  { domain: 'ngrok.debugg.ai', transport: 'ngrok' as const },
  { domain: 'tunnel.debugg.ai', transport: 'debugg' as const },
]);

const domains = new Map<string, TunnelTransportKind>(
  BUILT_IN_DOMAINS.map((d) => [d.domain, d.transport]),
);

/**
 * A tunnel domain must be a lowercase DNS name of at least THREE labels.
 *
 * The label count is a safety rule, not a style one: a registered domain
 * becomes a rewrite target, so accepting `debugg.ai` would make
 * `replaceTunnelUrls` rewrite every real product link in a backend response
 * (`https://app.debugg.ai/runs/1`) into the caller's localhost origin.
 */
export function isValidTunnelDomain(domain: unknown): domain is string {
  if (typeof domain !== 'string') return false;
  if (domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 3) return false;
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/**
 * Teach this process about a tunnel domain. Idempotent, and safe to call on
 * every provision. Returns false for a domain that fails validation, so a
 * caller can turn that into an error rather than silently trusting it.
 */
export function registerTunnelDomain(domain: string, transport: TunnelTransportKind): boolean {
  if (!isValidTunnelDomain(domain)) return false;
  domains.set(domain, transport);
  return true;
}

/** Every known domain, built-in and registered. */
export function knownTunnelDomains(): TunnelDomainInfo[] {
  return [...domains.entries()].map(([domain, transport]) => ({ domain, transport }));
}

/** The known domain a host sits under, or undefined. Accepts a host or a full URL. */
export function tunnelDomainFor(hostOrUrl: string): TunnelDomainInfo | undefined {
  const host = hostOf(hostOrUrl);
  if (!host) return undefined;
  for (const [domain, transport] of domains) {
    // A tunnel host is always `<label>.<domain>` — never the bare domain.
    if (host.length > domain.length + 1 && host.endsWith(`.${domain}`)) {
      return { domain, transport };
    }
  }
  return undefined;
}

export function isTunnelHost(hostOrUrl: string): boolean {
  return tunnelDomainFor(hostOrUrl) !== undefined;
}

/** The tunnel id (the leftmost label) of a tunnel host, or null. */
export function extractTunnelIdFromHost(hostOrUrl: string): string | null {
  const host = hostOf(hostOrUrl);
  const info = host ? tunnelDomainFor(host) : undefined;
  if (!host || !info) return null;
  const label = host.slice(0, host.length - info.domain.length - 1);
  return label.includes('.') ? null : label;
}

/**
 * `https?://<label>.<known domain>` as one alternation, for whole-string
 * rewriting. Rebuilt per call because the set can grow at runtime; these are
 * short lists and the callers are not hot loops.
 */
export function tunnelUrlPattern(): RegExp {
  const alternatives = [...domains.keys()].map(escapeRegExp).join('|');
  return new RegExp(`https?:\\/\\/[^\\s/"']+\\.(?:${alternatives})`, 'g');
}

function hostOf(hostOrUrl: string): string | undefined {
  if (typeof hostOrUrl !== 'string' || hostOrUrl.length === 0) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostOrUrl)) {
    try {
      return new URL(hostOrUrl).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
  // A bare host, possibly with a port.
  return hostOrUrl.split('/')[0].split(':')[0].toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Test hook: drop every runtime-registered domain, keeping the built-ins. */
export function _resetTunnelDomainsForTests(): void {
  domains.clear();
  for (const { domain, transport } of BUILT_IN_DOMAINS) domains.set(domain, transport);
}
