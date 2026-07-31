/**
 * Tunnel Management Service
 *
 * ONE ngrok tunnel per SESSION KEY (§2.1 of
 * docs/local-tunnel-multiplexer-architecture-2026-07-31.md) — not one per
 * local port. A session's tunnel dials a local Caddy instance
 * (services/caddy/caddyProxy.ts) that holds exactly one dynamic upstream,
 * repointed via Caddy's admin API immediately before each tool dispatch
 * under a per-session PortLock (services/caddy/portLock.ts) that serializes
 * different-port calls but not same-port ones.
 *
 * This retires the entire cross-process "borrow another MCP's tunnel"
 * mechanism the previous per-port design needed (registry-mediated adoption,
 * PID-liveness/freshness checks, re-adoption from the local ngrok agent) —
 * see §4's "Same-machine multi-process / multi-session sharing" decision:
 * "No sharing, ever, at any granularity." Every tunnel this process holds is
 * one it created; `services/ngrok/tunnelRegistry.ts` is now write-mostly
 * observability, not a correctness dependency.
 *
 * Session identity (§2.1): stdio has exactly one session key for its whole
 * process life. HTTP transport derives a distinct key per caller from the
 * request-scoped bearer token (utils/requestContext.ts), because a bare
 * module singleton serving many HTTP callers on one process must not let two
 * different callers share one Caddy route — that would be a cross-tenant
 * correctness bug, not just a cost one.
 *
 * A single, permanent, named exception: `run_test_suite` is fire-and-forget
 * (no poll loop, no bounded window this process can hold a lock over), so it
 * gets its own dedicated per-call tunnel via `acquireDedicatedTunnel()` that
 * bypasses Caddy/PortLock entirely — see §2.3.
 */

import { Logger } from '../../utils/logger.js';
import { Telemetry, TelemetryEvents } from '../../utils/telemetry.js';
import { extractLocalhostPort, generateTunnelUrl } from '../../utils/urlParser.js';
import { currentApiKey } from '../../utils/requestContext.js';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { FaultInjector, TunnelTrace, getFaultModeFromEnv } from './tunnelFaultInjection.js';
import {
  RegistryStore,
  getDefaultRegistry,
} from './tunnelRegistry.js';
import { startAgentSession, AgentSessionStarter } from './ngrokAgentSession.js';
import {
  createCaddyProxy,
  isDockerEnv,
  type CaddyProxy,
} from '../caddy/caddyProxy.js';
import { PortLock } from '../caddy/portLock.js';

let ngrokModule: any = null;

async function getNgrok() {
  if (!ngrokModule) {
    try {
      ngrokModule = await import('ngrok');
    } catch (error) {
      throw new Error(`Failed to load ngrok module: ${error}`);
    }
  }
  return ngrokModule;
}

/**
 * Reset the cached ngrok module so the next connect() bootstraps a fresh agent.
 * Called when the last tunnel is disconnected and the agent process may have died.
 */
function resetNgrokModule(): void {
  ngrokModule = null;
}

const logger = new Logger({ module: 'tunnelManager' });

// ── Session identity (§2.1) ────────────────────────────────────────────────────

/**
 * Derives this call's session key. stdio: `currentApiKey()` is always
 * unset (nothing on the stdio path ever calls
 * `utils/requestContext.ts`'s `runWithApiKey`), so every stdio call
 * legitimately collapses onto the fixed `'stdio'` key — that IS "one
 * process = one caller for its whole life" (§2.1), not a fallback failure.
 *
 * HTTP: every request MUST carry a bearer token by the time it reaches tunnel
 * logic — `httpServer.ts` 401s on a missing token before ever calling
 * `runWithApiKey` — so `currentApiKey()` returning undefined while
 * `DEBUGGAI_MCP_TRANSPORT=http` is genuinely anomalous: it means two
 * different HTTP callers could collapse onto the same session key and get
 * routed into each other's local dev server. That specific case is logged
 * loudly so it surfaces in practice.
 *
 * NOTE — this deliberately deviates from the architecture doc's §2.1
 * pseudocode, which logs `logger.error` on EVERY `!apiKey` fallback with no
 * way to tell "expected stdio call" apart from "HTTP call with isolation
 * broken" (both read as `currentApiKey() === undefined`). Following the doc
 * literally would fire an ERROR log on every single stdio tool call — a
 * regression, not a safety net. `DEBUGGAI_MCP_TRANSPORT` (already read by
 * index.ts to choose stdio vs HTTP at startup) is the signal that lets the
 * two cases be told apart; using it here is a bug fix over the doc's literal
 * text, not a simplification of its intent (§6's "no-API-key fallback"
 * finding is still tracked — the loud log now actually only fires for the
 * case it was meant to catch).
 */
export function getSessionKey(): string {
  const apiKey = currentApiKey();
  if (apiKey) {
    return `http:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
  }
  const transportMode = (process.env.DEBUGGAI_MCP_TRANSPORT || 'stdio').toLowerCase();
  if (transportMode === 'http') {
    logger.error(
      'getSessionKey(): HTTP transport reached tunnel logic with no API key in request context — ' +
      'falling back to a shared key. This MUST NOT be reachable on an authenticated HTTP path; ' +
      'if it fires, tunnel isolation between callers is broken.',
    );
  }
  return 'stdio';
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TunnelInfo {
  tunnelId: string;
  /** §2.1 — replaces `port` as the identity a tunnel is keyed by. */
  sessionKey: string;
  /** Bare origin returned by ngrok.connect() — unchanged meaning (bead zmc9);
   *  per-caller path baking happens at the call site via retargetTunnelUrl. */
  tunnelUrl: string;
  createdAt: number;
  lastAccessedAt: number;
  autoShutoffTimer?: NodeJS.Timeout;
  /** Backend ngrok API key ID — revoked when this tunnel stops. */
  keyId?: string;
  /** Callback to revoke the backend key on stop. */
  revokeKey?: () => Promise<void>;
  /** This session's own Caddy instance — never a process-wide singleton. */
  caddy: CaddyProxy;
  /** This session's own port-route lock (§2.4), bound to `caddy`. */
  portLock: PortLock;
}

/**
 * Bookkeeping for the `run_test_suite` exception (§2.3): a tunnel that
 * dials the local app DIRECTLY, bypassing Caddy/PortLock entirely. Kept
 * separate from `TunnelInfo` rather than made an optional-Caddy variant of
 * it, because nothing about it participates in the session-tunnel
 * abstraction (no shared route to serialize, no `sessionKey` identity to
 * dedup on — `acquireDedicatedTunnel` always mints a fresh one).
 */
interface DirectTunnelInfo {
  tunnelId: string;
  tunnelUrl: string;
  createdAt: number;
  lastAccessedAt: number;
  autoShutoffTimer?: NodeJS.Timeout;
  keyId?: string;
  revokeKey?: () => Promise<void>;
}

// ── TunnelManager ─────────────────────────────────────────────────────────────

class TunnelManager {
  private activeTunnels = new Map<string, TunnelInfo>();
  private directTunnels = new Map<string, DirectTunnelInfo>();
  /** sessionKey -> tunnelId, for the fast "already have a tunnel" path. */
  private sessionTunnels = new Map<string, string>();
  /** sessionKey -> in-flight creation, so concurrent first calls for a fresh
   *  session key join one creation instead of each minting their own (§2.3's
   *  cold-start TOCTOU fix — see ensureSessionTunnel()). */
  private pendingSessionTunnels = new Map<string, Promise<TunnelInfo>>();
  private initialized = false;

  /**
   * Idle window before a tunnel auto-shuts-off. Public so timer tests can run
   * in milliseconds instead of 55 minutes, matching the `connectBackoffMs` /
   * `agentSessionStarter` precedent.
   */
  public idleTimeoutMs = 55 * 60 * 1000;
  /**
   * Backoff schedule (ms) between ngrok.connect() retry attempts. Bead ixh.
   * Exposed on the class so tests can override with short delays without
   * changing the public API or depending on jest fake timers.
   */
  public connectBackoffMs: number[] = [500, 1500];
  /**
   * Bead pqgj: how the ngrok agent gets started + how we learn its client
   * session is live. Overridable so tests can drive a fake agent instead of
   * spawning a real ngrok process.
   */
  public agentSessionStarter: AgentSessionStarter = startAgentSession;
  /**
   * Cap on waiting for "client session established". Measured live at ~293ms;
   * this is a generous ceiling, not an expected wait. On expiry we tunnel
   * anyway and let the retry ladder handle it — a slow session must not become
   * a hang.
   */
  public agentSessionTimeoutMs = 5000;
  /**
   * §2.2/§2.3: one fresh `CaddyProxy` instance PER SESSION KEY, never a
   * process-wide singleton. Overridable so tests drive a fake proxy instead
   * of spawning a real `caddy` process.
   */
  public caddyFactory: () => CaddyProxy = createCaddyProxy;

  /** Whether the ngrok agent's client session is established (bead pqgj). */
  private agentSessionReady = false;
  /** In-flight session bootstrap, so concurrent tunnels wait on one spawn. */
  private agentSessionPromise: Promise<void> | null = null;

  constructor(private readonly reg: RegistryStore = getDefaultRegistry()) {
    // Bead `mdp`: sweep dead-owner entries on startup so the (now purely
    // diagnostic — §4) registry doesn't grow unboundedly across MCP
    // processes that exited without stopAllTunnels (SIGKILL / crash).
    // Best-effort — no-op registries don't actually prune.
    try {
      const result = this.reg.prune();
      if (result.pruned > 0) {
        logger.info(`Pruned ${result.pruned} stale registry entries on startup (${result.remaining} remaining)`);
      }
    } catch (err) {
      logger.warn(`Registry prune-on-startup failed (non-fatal): ${err}`);
    }
  }

  // ── Public API — session tunnels ───────────────────────────────────────────

  /**
   * The single entry point for "get me the tunnel for my session," replacing
   * `processUrl()`/`processPerPort()`. Idempotent per session key: the first
   * caller creates, everyone else — concurrent or sequential — reuses.
   *
   * §2.3's cold-start TOCTOU fix: the read (`sessionTunnels.get`) and the
   * eventual write (`sessionTunnels.set`) are separated by several `await`
   * points (spawning Caddy, connecting ngrok). Two near-simultaneous first
   * calls for the same fresh session key — exactly what an orchestrating
   * agent produces (an initial navigate fired alongside an initial probe) —
   * would otherwise both observe a miss and each mint their own tunnel,
   * silently defeating "one tunnel per session" at the moment most likely to
   * have concurrent calls. `pendingSessionTunnels` closes that window: the
   * claim (steps 2-3 below) is entirely synchronous relative to each other,
   * so whichever call runs its synchronous prefix first wins the map slot,
   * and the other necessarily observes it on its own synchronous prefix.
   */
  async ensureSessionTunnel(
    sessionKey: string,
    authToken: string,
    specificTunnelId?: string,
    keyId?: string,
    revokeKey?: () => Promise<void>,
  ): Promise<TunnelInfo> {
    // 1. Fast path: a fully-created tunnel already exists for this session key.
    const existingId = this.sessionTunnels.get(sessionKey);
    if (existingId) {
      const info = this.activeTunnels.get(existingId);
      if (info) {
        this.touchTunnel(info.tunnelId);
        return info;
      }
    }

    // 2. A creation is already in flight for this session key — join it
    //    rather than starting a second one.
    const inFlight = this.pendingSessionTunnels.get(sessionKey);
    if (inFlight) return inFlight;

    // 3. First caller for this session key: claim the slot BEFORE any await.
    const creation = this.createSessionTunnel(sessionKey, authToken, specificTunnelId, keyId, revokeKey)
      .finally(() => { this.pendingSessionTunnels.delete(sessionKey); });
    this.pendingSessionTunnels.set(sessionKey, creation);
    return creation;
  }

  /** Cheap peek: an already-created session tunnel, or undefined. Never
   *  provisions anything — used by callers that want to skip a backend key
   *  provision step when reuse is possible (utils/tunnelContext.ts's
   *  findExistingTunnel, mirroring the old getTunnelForPort's role). */
  getSessionTunnelInfo(sessionKey: string): TunnelInfo | undefined {
    const tunnelId = this.sessionTunnels.get(sessionKey);
    return tunnelId ? this.activeTunnels.get(tunnelId) : undefined;
  }

  getTunnelInfo(tunnelId: string): TunnelInfo | undefined {
    return this.activeTunnels.get(tunnelId);
  }

  getActiveTunnels(): TunnelInfo[] {
    return Array.from(this.activeTunnels.values());
  }

  // ── Public API — the run_test_suite exception (§2.3) ───────────────────────

  /**
   * Used ONLY by runTestSuiteHandler.ts. Bypasses Caddy/PortLock entirely —
   * dials ngrok straight at the app, exactly like today's per-port
   * createTunnel(). Governed by the same idleTimeoutMs auto-shutoff as any
   * other tunnel. This is a deliberate, scoped exception to "one tunnel per
   * session" (§2.3) — not a smuggled-in legacy fallback — forced by
   * run_test_suite's async execution model: it is fire-and-forget (no poll
   * loop, no bounded window this process can hold a lock over), so holding
   * the shared session lock for "the whole call" would give it no protection
   * at all — the lock would release back to contention seconds after
   * triggering a suite that goes on to use the port for possibly many more
   * minutes.
   *
   * A session that calls both a Caddy-routed tool AND run_test_suite pays for
   * 2 tunnels for that session — honest and bounded, flagged in §6.
   */
  async acquireDedicatedTunnel(
    url: string,
    authToken: string,
    keyId?: string,
    revokeKey?: () => Promise<void>,
  ): Promise<{ url: string; tunnelId: string }> {
    await this.ensureInitialized();

    const port = extractLocalhostPort(url);
    if (!port) {
      throw new Error(`acquireDedicatedTunnel: could not extract port from localhost URL: ${url}`);
    }

    const tunnelId = uuidv4();
    const tunnelDomain = `${tunnelId}.ngrok.debugg.ai`;
    const isHttpsLocal = url.startsWith('https:');
    const inDocker = isDockerEnv();
    // NOTE: this intentionally does NOT reuse caddyProxy.ts's
    // resolveDialAddress() — that function builds Caddy's JSON `dial` field,
    // which is always a bare `host:port` (Caddy conveys TLS-ness via its
    // separate `transport` field, never a URL scheme in `dial`). ngrok's
    // own `connect({ addr })` option is a different consumer with a
    // different format: it DOES need a `https://` scheme prefix for an
    // HTTPS local target (see the original tunnelManager.ts:696-701, which
    // this path preserves byte-for-byte since it dials the app directly,
    // exactly like the pre-cutover per-port createTunnel()). Reusing
    // resolveDialAddress() here would silently drop that scheme and break
    // HTTPS dedicated tunnels.
    const dockerHost = 'host.docker.internal';
    let localAddr: string;
    if (isHttpsLocal) {
      localAddr = inDocker ? `https://${dockerHost}:${port}` : `https://localhost:${port}`;
    } else {
      localAddr = inDocker ? `${dockerHost}:${port}` : `127.0.0.1:${port}`;
    }

    logger.info(
      `Creating dedicated tunnel for localhost:${port} (domain: ${tunnelDomain}) — ` +
      'run_test_suite exception, bypasses Caddy',
    );

    const faultMode = getFaultModeFromEnv();
    const faults = new FaultInjector(faultMode);
    const trace = new TunnelTrace();
    trace.emit('acquireDedicatedTunnel.start', { port, tunnelId, hasFaultMode: !!faultMode });

    try {
      const tunnelUrl = await this.connectWithRetry(localAddr, tunnelDomain, authToken, trace, faults);
      const now = Date.now();
      const info: DirectTunnelInfo = {
        tunnelId, tunnelUrl, createdAt: now, lastAccessedAt: now, keyId, revokeKey,
      };
      this.directTunnels.set(tunnelId, info);
      this.writeRegistryEntry(tunnelId, `dedicated:${tunnelId}`, tunnelUrl, -1);
      this.armIdleTimer(info);

      trace.emit('acquireDedicatedTunnel.success', { tunnelId, tunnelUrl });
      logger.info(`Dedicated tunnel created: ${tunnelUrl} -> localhost:${port}`);
      Telemetry.capture(TelemetryEvents.TUNNEL_PROVISIONED, { tunnelId, how: 'created-dedicated' });
      return { url: generateTunnelUrl(url, tunnelId), tunnelId };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      trace.emit('acquireDedicatedTunnel.fail', { message: msg.slice(0, 200) });
      logger.warn(`Tunnel lifecycle trace (fail path):\n${trace.format()}`);
      if (msg.includes('authtoken')) {
        throw new Error(`Failed to create tunnel: invalid auth token. ${msg}`);
      }
      throw new Error(`Failed to create tunnel: ${msg}`);
    }
  }

  // ── Public API — lifecycle / teardown ──────────────────────────────────────

  /**
   * Evict a tunnel that a health probe PROVED dead (e.g. ERR_NGROK_3200) —
   * simplifies to a plain delegate now that every tunnel is created (never
   * borrowed) by this process: there is no shared-registry adoption record
   * to also evict (bead k34o's second half retired along with borrowing,
   * §4). Drops the `port` parameter — eviction is no longer port-scoped.
   */
  async markTunnelDead(tunnelId: string): Promise<void> {
    await this.stopTunnel(tunnelId);
  }

  /**
   * `stopTunnel()`'s ordering is a load-bearing contract, not an
   * implementation detail (§2.3): map removal is UNCONDITIONAL and happens
   * before any cleanup I/O, so a downstream cleanup failure (ngrok
   * disconnect, `caddy.stop()`, key revoke) can never leave a
   * live-looking-but-actually-dead `TunnelInfo` behind for the next call to
   * find — the exact failure mode the `onPortChanged`-triggered eviction
   * path (see createSessionTunnel) exists to avoid re-creating. Because this
   * never throws (failures are caught inside `Promise.allSettled`, not
   * propagated), callers — including a queued lock waiter promoted against a
   * Caddy instance mid-teardown — never need a defensive `.catch()` of their
   * own.
   */
  async stopTunnel(tunnelId: string): Promise<void> {
    const info = this.activeTunnels.get(tunnelId);
    if (info) {
      await this.stopSessionTunnel(info);
      return;
    }
    const direct = this.directTunnels.get(tunnelId);
    if (direct) {
      await this.stopDirectTunnel(direct);
      return;
    }
    logger.warn(`Tunnel ${tunnelId} not found for cleanup`);
  }

  async stopAllTunnels(): Promise<void> {
    const ids = [...this.activeTunnels.keys(), ...this.directTunnels.keys()];
    await Promise.all(
      ids.map((id) =>
        this.stopTunnel(id).catch((err) =>
          logger.error(`Failed to stop tunnel ${id}:`, err)
        )
      )
    );
    logger.info(`Stopped ${ids.length} tunnel(s)`);
  }

  /** Refresh a tunnel's idle timer (and its diagnostic registry row) —
   *  called on every reuse so an in-use tunnel never auto-shuts-off. */
  touchTunnel(tunnelId: string): void {
    const info = this.activeTunnels.get(tunnelId);
    if (info) {
      this.touchRegistryEntry(tunnelId);
      this.armIdleTimer(info);
      return;
    }
    const direct = this.directTunnels.get(tunnelId);
    if (direct) {
      this.touchRegistryEntry(tunnelId);
      this.armIdleTimer(direct);
    }
  }

  touchTunnelByUrl(url: string): void {
    const tunnelId = this.extractTunnelId(url);
    if (tunnelId) {
      this.touchTunnel(tunnelId);
    }
  }

  isTunnelUrl(url: string): boolean {
    return url.includes('.ngrok.debugg.ai');
  }

  extractTunnelId(url: string): string | null {
    const match = url.match(/https?:\/\/([^.]+)\.ngrok\.debugg\.ai/);
    return match ? match[1] : null;
  }

  getTunnelStatus(tunnelId: string): {
    tunnel: TunnelInfo;
    age: number;
    timeSinceLastAccess: number;
    timeUntilAutoShutoff: number;
  } | null {
    const tunnel = this.activeTunnels.get(tunnelId);
    if (!tunnel) return null;

    const now = Date.now();
    return {
      tunnel,
      age: now - tunnel.createdAt,
      timeSinceLastAccess: now - tunnel.lastAccessedAt,
      timeUntilAutoShutoff: Math.max(0, tunnel.lastAccessedAt + this.idleTimeoutMs - now),
    };
  }

  getAllTunnelStatuses() {
    const statuses = [];
    for (const tunnelId of this.activeTunnels.keys()) {
      const status = this.getTunnelStatus(tunnelId);
      if (status) statuses.push(status);
    }
    return statuses;
  }

  // ── Session tunnel creation ─────────────────────────────────────────────────

  private async createSessionTunnel(
    sessionKey: string,
    authToken: string,
    specificTunnelId?: string,
    keyId?: string,
    revokeKey?: () => Promise<void>,
  ): Promise<TunnelInfo> {
    await this.ensureInitialized();

    const tunnelId = specificTunnelId ?? uuidv4();
    const tunnelDomain = `${tunnelId}.ngrok.debugg.ai`; // UNCHANGED scheme, minted ONCE per session now
    const caddy = this.caddyFactory(); // NEW instance per session key — never a process-wide singleton
    const { localOrigin, adminPort } = await caddy.ensureStarted();

    logger.info(`Creating session tunnel (domain: ${tunnelDomain}, session: ${sessionKey})`);

    // Bead 42g: fault injection + trace. Only active when NODE_ENV !== 'production'
    // AND DEBUGG_TUNNEL_FAULT_MODE env var is set. Zero overhead when disabled.
    const faultMode = getFaultModeFromEnv();
    const faults = new FaultInjector(faultMode);
    const trace = new TunnelTrace();
    trace.emit('createSessionTunnel.start', { tunnelId, sessionKey, hasFaultMode: !!faultMode });

    try {
      // ngrok's own dial target is now always plain loopback HTTP to Caddy —
      // no HTTPS/Docker complexity on this leg at all (Caddy runs in the same
      // host/container as the MCP server). That matrix moved entirely into
      // caddyProxy.setUpstream(), invoked per-dispatch, not per-tunnel-creation.
      const tunnelUrl = await this.connectWithRetry(localOrigin, tunnelDomain, authToken, trace, faults);

      const now = Date.now();
      const portLock = new PortLock((t) => caddy.setUpstream(t));
      caddy.onPortChanged(() => {
        // A crash-triggered respawn landed on a DIFFERENT local proxy port
        // (sticky-port reclaim failed). The existing ngrok tunnel is now
        // dialing a dead port — nothing Caddy-internal can fix this; the
        // whole session tunnel must be torn down and recreated on the next
        // call. stopTunnel() never throws (its unconditional-removal
        // contract, above), so this needs no defensive .catch() of its own.
        logger.error(`Caddy proxy port changed under session ${sessionKey} — evicting tunnel ${tunnelId}`);
        Telemetry.capture(TelemetryEvents.TUNNEL_EVICTED_PORT_CHANGED, { tunnelId, sessionKey });
        void this.stopTunnel(tunnelId);
      });

      const info: TunnelInfo = {
        tunnelId, sessionKey, tunnelUrl, createdAt: now, lastAccessedAt: now,
        keyId, revokeKey, caddy, portLock,
      };
      this.activeTunnels.set(tunnelId, info);
      this.sessionTunnels.set(sessionKey, tunnelId);
      this.writeRegistryEntry(tunnelId, sessionKey, tunnelUrl, adminPort);
      this.armIdleTimer(info);

      trace.emit('createSessionTunnel.success', { tunnelId, tunnelUrl });
      logger.info(`Session tunnel created: ${tunnelUrl} (session ${sessionKey})`);
      Telemetry.capture(TelemetryEvents.TUNNEL_PROVISIONED, { tunnelId, how: 'created' });
      return info;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      trace.emit('createSessionTunnel.fail', { message: msg.slice(0, 200) });
      // Bead 42g: when the trace captured meaningful timing info, log it at
      // WARN so operators can post-mortem. Keeping it out of the thrown error
      // text so we don't leak internals to users.
      logger.warn(`Tunnel lifecycle trace (fail path):\n${trace.format()}`);
      // Never leak a Caddy process on connect failure — nothing else will
      // ever stop() an instance that never made it into activeTunnels.
      await caddy.stop().catch(() => {});
      if (msg.includes('authtoken')) {
        throw new Error(`Failed to create tunnel: invalid auth token. ${msg}`);
      }
      throw new Error(`Failed to create tunnel: ${msg}`);
    }
  }

  // ── Shared connect-retry ladder (KEPT byte-for-byte — bead ixh/pqgj/42g/fhg) ─

  /**
   * Bead ixh: 3-attempt retry for ngrok.connect transient failures.
   * - Attempt 1: fresh connect
   * - Attempt 2: after 500ms backoff, reset the ngrok agent module and retry
   *   (existing "agent died" recovery path)
   * - Attempt 3: after 1500ms backoff, retry with the already-reset agent
   * Auth-token errors short-circuit at any attempt — no point looping.
   *
   * Parameterized by `localAddr` rather than computing it internally: the
   * session-tunnel path (createSessionTunnel) always dials Caddy's fixed
   * local origin; the dedicated-tunnel path (acquireDedicatedTunnel) dials
   * the app directly via the isHttpsLocal/inDocker matrix. Both need the
   * IDENTICAL retry/backoff/fault-injection/agent-prewarm behavior, so it
   * lives here once.
   */
  private async connectWithRetry(
    localAddr: string,
    tunnelDomain: string,
    authToken: string,
    trace: TunnelTrace,
    faults: FaultInjector,
  ): Promise<string> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const BACKOFF_MS = this.connectBackoffMs; // bead ixh: test-overridable
    const MAX_ATTEMPTS = BACKOFF_MS.length + 1; // N sleeps between N+1 attempts
    const connectOpts = {
      proto: 'http' as const,
      addr: localAddr,
      hostname: tunnelDomain,
      authtoken: authToken,
    };

    // Bead pqgj: pre-warm the agent session so attempt 1 doesn't race the
    // agent's ~293ms not-ready window (which poisons the tunnel name via
    // ngrok's own name-reusing internal retry and surfaces as
    // "invalid tunnel configuration").
    await this.ensureAgentSession(authToken, trace);

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      trace.emit('connect.attempt.start', { attempt });
      // Optional fault-injected delay before each attempt.
      const delayMs = faults.delayMsForAttempt();
      if (delayMs > 0) {
        trace.emit('connect.fault.delay', { attempt, delayMs });
        await sleep(delayMs);
      }
      try {
        const ngrok = await getNgrok();
        // Fault-inject a synthetic failure BEFORE ngrok.connect runs so we
        // can simulate connect-layer failures without hitting the real API.
        if (faults.shouldFailConnect()) {
          trace.emit('connect.fault.inject', { attempt, mode: 'fail-connect-N' });
          throw new Error(`[fault-inject] synthetic connect failure (attempt ${attempt})`);
        }
        const url = faults.shouldReturnEmptyUrl() ? '' : await ngrok.connect(connectOpts);
        if (!url) {
          trace.emit('connect.attempt.empty-url', { attempt });
          throw new Error(`ngrok.connect() returned empty URL (attempt ${attempt})`);
        }
        trace.emit('connect.attempt.success', { attempt });
        if (attempt > 1) {
          Telemetry.capture(TelemetryEvents.TUNNEL_PROVISION_RETRY, {
            attempt,
            outcome: 'success',
            stage: 'ngrok_connect',
          });
        }
        return url;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        trace.emit('connect.attempt.fail', { attempt, message: msg.slice(0, 200) });

        // Auth-class errors are non-retryable — retrying with the same token
        // would loop. Let the outer catch classify the message.
        if (/authtoken|unauthorized|\b401\b|\b403\b/i.test(msg)) {
          trace.emit('connect.giving-up', { reason: 'auth-error' });
          Telemetry.capture(TelemetryEvents.TUNNEL_PROVISION_RETRY, {
            attempt,
            outcome: 'giving-up',
            stage: 'ngrok_connect',
            reason: 'auth-error',
          });
          throw err;
        }

        const isLastAttempt = attempt >= MAX_ATTEMPTS;
        Telemetry.capture(TelemetryEvents.TUNNEL_PROVISION_RETRY, {
          attempt,
          outcome: isLastAttempt ? 'giving-up' : 'will-retry',
          stage: 'ngrok_connect',
        });

        if (isLastAttempt) {
          trace.emit('connect.giving-up', { reason: 'max-attempts' });
          throw err;
        }

        // Between attempt 1→2, do an agent-reset (covers the "agent died"
        // failure mode that used to be the only retried case). Between 2→3,
        // just wait — the reset already happened.
        if (attempt === 1) {
          logger.warn(`ngrok.connect() failed (attempt 1/${MAX_ATTEMPTS}), resetting agent: ${msg}`);
          trace.emit('agent.reset');
          resetNgrokModule();
          this.initialized = false;
          await this.ensureInitialized();
        } else {
          logger.warn(`ngrok.connect() failed (attempt ${attempt}/${MAX_ATTEMPTS}), will retry: ${msg}`);
        }
        const backoffMs = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
        trace.emit('connect.backoff', { attempt, backoffMs });
        await sleep(backoffMs);
      }
    }
    // Unreachable (loop always returns or throws), but satisfy TS
    throw lastError ?? new Error('connectWithRetry: exhausted attempts without error');
  }

  // ── Teardown internals ──────────────────────────────────────────────────────

  private async stopSessionTunnel(info: TunnelInfo): Promise<void> {
    // Unconditional, synchronous, BEFORE any cleanup I/O. A partial failure
    // below can never leave stale-but-discoverable state — the next call for
    // this session key always sees a clean miss and rebuilds from scratch.
    this.activeTunnels.delete(info.tunnelId);
    if (this.sessionTunnels.get(info.sessionKey) === info.tunnelId) {
      this.sessionTunnels.delete(info.sessionKey);
    }
    if (info.autoShutoffTimer) clearTimeout(info.autoShutoffTimer);
    this.removeRegistryEntry(info.tunnelId);

    const results = await Promise.allSettled([
      this.disconnectNgrok(info.tunnelUrl),
      info.caddy.stop(),
      info.revokeKey ? info.revokeKey() : Promise.resolve(),
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        // Logged and telemetered, never rethrown and never blocks/reverts the
        // removal above — state is already gone by the time this runs.
        logger.warn(`stopTunnel(${info.tunnelId}) cleanup step ${i} failed (state already removed): ${r.reason}`);
        Telemetry.capture(TelemetryEvents.TUNNEL_TEARDOWN_PARTIAL_FAILURE, { tunnelId: info.tunnelId, step: i });
      }
    });

    this.maybeResetNgrokModule();
    logger.info(`Cleaned up session tunnel: ${info.tunnelUrl}`);
    Telemetry.capture(TelemetryEvents.TUNNEL_STOPPED, { tunnelId: info.tunnelId, reason: 'stopped' });
  }

  private async stopDirectTunnel(info: DirectTunnelInfo): Promise<void> {
    // Same unconditional-removal contract as stopSessionTunnel, above.
    this.directTunnels.delete(info.tunnelId);
    if (info.autoShutoffTimer) clearTimeout(info.autoShutoffTimer);
    this.removeRegistryEntry(info.tunnelId);

    const results = await Promise.allSettled([
      this.disconnectNgrok(info.tunnelUrl),
      info.revokeKey ? info.revokeKey() : Promise.resolve(),
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        logger.warn(`stopTunnel(${info.tunnelId}) dedicated-tunnel cleanup step ${i} failed (state already removed): ${r.reason}`);
        Telemetry.capture(TelemetryEvents.TUNNEL_TEARDOWN_PARTIAL_FAILURE, { tunnelId: info.tunnelId, step: i });
      }
    });

    this.maybeResetNgrokModule();
    logger.info(`Cleaned up dedicated tunnel: ${info.tunnelUrl}`);
    Telemetry.capture(TelemetryEvents.TUNNEL_STOPPED, { tunnelId: info.tunnelId, reason: 'stopped' });
  }

  private async disconnectNgrok(tunnelUrl: string): Promise<void> {
    const ngrok = await getNgrok();
    await ngrok.disconnect(tunnelUrl);
  }

  /** If no tunnels of any kind remain, the ngrok agent process may have
   *  exited. Reset module + init state so the next connect() bootstraps a
   *  fresh agent. */
  private maybeResetNgrokModule(): void {
    if (this.activeTunnels.size === 0 && this.directTunnels.size === 0) {
      logger.info('No tunnels remain — resetting ngrok module for fresh init on next request');
      resetNgrokModule();
      this.initialized = false;
    }
  }

  // ── Idle timer (KEPT — minus the retired cross-process extension branch) ───

  /**
   * Bead y7x6/lc62's cross-process "another process touched the registry
   * entry, so extend instead of shutting down" branch is retired along with
   * borrowing (§4/§5.1): every tunnel now has exactly one process that could
   * ever be using it, so there is nothing else to check for before shutting
   * an idle one down. The core mechanism — arm a timer, clear+rearm on
   * touch, stop on expiry — is otherwise unchanged.
   */
  private armIdleTimer(entry: { tunnelId: string; autoShutoffTimer?: NodeJS.Timeout; lastAccessedAt: number }): void {
    if (entry.autoShutoffTimer) clearTimeout(entry.autoShutoffTimer);
    entry.lastAccessedAt = Date.now();
    entry.autoShutoffTimer = setTimeout(async () => {
      logger.info(`Auto-shutting down tunnel ${entry.tunnelId} after inactivity`);
      Telemetry.capture(TelemetryEvents.TUNNEL_STOPPED, { tunnelId: entry.tunnelId, reason: 'auto-shutoff' });
      await this.stopTunnel(entry.tunnelId).catch((err) =>
        logger.error(`Failed to auto-shutdown tunnel ${entry.tunnelId}:`, err)
      );
    }, this.idleTimeoutMs);
  }

  // ── Registry writes (§4: write-mostly observability, best-effort) ──────────

  private writeRegistryEntry(tunnelId: string, sessionKey: string, tunnelUrl: string, caddyAdminPort: number): void {
    try {
      const registry = this.reg.read();
      registry[tunnelId] = {
        tunnelId,
        sessionKey,
        publicUrl: tunnelUrl,
        tunnelUrl,
        caddyAdminPort,
        ownerPid: process.pid,
        lastAccessedAt: Date.now(),
      };
      this.reg.write(registry);
    } catch {
      // best-effort — nothing reads this for correctness anymore
    }
  }

  private touchRegistryEntry(tunnelId: string): void {
    try {
      const registry = this.reg.read();
      if (registry[tunnelId]) {
        registry[tunnelId].lastAccessedAt = Date.now();
        this.reg.write(registry);
      }
    } catch {
      // best-effort
    }
  }

  private removeRegistryEntry(tunnelId: string): void {
    try {
      const registry = this.reg.read();
      if (registry[tunnelId]) {
        delete registry[tunnelId];
        this.reg.write(registry);
      }
    } catch {
      // best-effort
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Bead pqgj: make sure the ngrok agent's client session is established before
   * we ask it for a tunnel, so attempt 1 lands on a ready agent instead of the
   * ~293ms not-ready window that made every single run fail its first connect.
   *
   * Never throws: if the agent can't be pre-warmed (ngrok internals moved, slow
   * session, dead token) we fall through and let connectWithRetry's ladder do
   * what it did before this fix. The ladder stays a genuine safety net.
   */
  private async ensureAgentSession(authtoken: string, trace?: TunnelTrace): Promise<void> {
    if (this.agentSessionReady) return;

    if (!this.agentSessionPromise) {
      this.agentSessionPromise = (async () => {
        let markEstablished!: () => void;
        const established = new Promise<void>((resolve) => { markEstablished = resolve; });

        await this.agentSessionStarter({
          authtoken,
          onStatusChange: (status: string) => {
            if (status === 'connected') {
              this.agentSessionReady = true;
              markEstablished();
            } else if (status === 'closed') {
              this.agentSessionReady = false;
            }
          },
          onTerminated: () => {
            // Agent process died — next tunnel must re-warm.
            this.agentSessionReady = false;
            this.agentSessionPromise = null;
          },
        });

        let capTimer: NodeJS.Timeout | undefined;
        const cap = new Promise<void>((resolve) => {
          capTimer = setTimeout(resolve, this.agentSessionTimeoutMs);
        });
        try {
          await Promise.race([established, cap]);
        } finally {
          if (capTimer) clearTimeout(capTimer);
        }
      })().catch((err) => {
        // Pre-warm unavailable — not fatal, the ladder covers it.
        this.agentSessionPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        trace?.emit('agent.session.prewarm-failed', { message: msg.slice(0, 200) });
        logger.debug(`ngrok agent pre-warm unavailable, relying on connect retry ladder: ${msg}`);
      });
    }

    await this.agentSessionPromise;
    trace?.emit('agent.session.ready', { ready: this.agentSessionReady });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      try {
        const ngrok = await getNgrok();
        ngrok.getApi();
      } catch {
        // ignore — let connect surface real errors
      }
      this.initialized = true;
    }
  }
}

const tunnelManager = new TunnelManager();

export { tunnelManager };
export default TunnelManager;
