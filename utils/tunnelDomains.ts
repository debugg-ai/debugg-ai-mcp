/**
 * The hostnames a tunnel URL can live on.
 *
 * What this is FOR: `replaceTunnelUrls` reads this list to keep a tunnel
 * hostname out of every tool response, so a domain it does not know is a URL
 * that leaks to the caller.
 *
 * A provision response may name a domain we do not ship (the backend moving
 * `tunnel.debugg.ai` elsewhere, or a local dev host), so domains can be
 * registered at runtime — that is what lets the server move without an MCP
 * release, the same reasoning as `relayUrl`.
 *
 * ┌─ DO NOT DELETE `ngrok.debugg.ai` AS DEAD CODE ─────────────────────────────┐
 * │ This client can no longer CREATE an ngrok tunnel — the ngrok transport was │
 * │ deleted. `ngrok.debugg.ai` stays here purely as a REWRITE TARGET, because  │
 * │ a backend response about a historical run (evidence, screenshots, an       │
 * │ execution's stored targetUrl) can still carry one of those hostnames. It   │
 * │ costs one entry in a list; removing it means those URLs leak to the caller │
 * │ verbatim. Retire it when no stored run references it any more — bead       │
 * │ debugg_ai_mcp-xkoh.6.6, which also drops the *.ngrok.debugg.ai DNS.        │
 * │ Locked by __tests__/utils/tunnelDomains.test.ts.                           │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Imports NOTHING, deliberately: utils/urlParser.ts, utils/localReachability.ts
 * and services/tunnel/tunnelManager.ts all depend on it, and it must never be
 * the module that creates a cycle.
 */

export interface TunnelDomainInfo {
  domain: string;
}

const LIVE_DOMAIN = 'tunnel.debugg.ai';
/** Rewrite-only. See the box above before touching this. */
const LEGACY_DOMAINS = ['ngrok.debugg.ai'];

const BUILT_IN_DOMAINS: ReadonlyArray<string> = Object.freeze([LIVE_DOMAIN, ...LEGACY_DOMAINS]);

const domains = new Set<string>(BUILT_IN_DOMAINS);

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
export function registerTunnelDomain(domain: string): boolean {
  if (!isValidTunnelDomain(domain)) return false;
  domains.add(domain);
  return true;
}

/** Every known domain, built-in and registered. */
export function knownTunnelDomains(): TunnelDomainInfo[] {
  return [...domains].map((domain) => ({ domain }));
}

/** The known domain a host sits under, or undefined. Accepts a host or a full URL. */
export function tunnelDomainFor(hostOrUrl: string): TunnelDomainInfo | undefined {
  const host = hostOf(hostOrUrl);
  if (!host) return undefined;
  for (const domain of domains) {
    // A tunnel host is always `<label>.<domain>` — never the bare domain.
    if (host.length > domain.length + 1 && host.endsWith(`.${domain}`)) {
      return { domain };
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
  const alternatives = [...domains].map(escapeRegExp).join('|');
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
  for (const domain of BUILT_IN_DOMAINS) domains.add(domain);
}
