/**
 * Tunnel Management Service
 *
 * Manages per-port ngrok tunnels with two layers of reuse:
 *
 *   1. Within-process  — activeTunnels map, 55-min auto-shutoff timer.
 *   2. Cross-process   — file-backed RegistryStore so a second MCP instance
 *                        on the same machine borrows an existing tunnel instead
 *                        of provisioning a new one for the same port.
 *
 * Lifecycle:
 *   - Owned tunnels  (isOwned=true)  : this process created them; it disconnects
 *                                      and revokes the key on stop.
 *   - Borrowed tunnels (isOwned=false): another process owns them; on stop we
 *                                       only remove the local reference.
 *   - Auto-shutoff timer checks the shared registry before firing: if another
 *     process recently touched the entry the timer resets instead of stopping.
 */

import { Logger } from '../../utils/logger.js';
import { Telemetry, TelemetryEvents } from '../../utils/telemetry.js';
import { isLocalhostUrl, extractLocalhostPort, generateTunnelUrl } from '../../utils/urlParser.js';
import { v4 as uuidv4 } from 'uuid';
import { FaultInjector, TunnelTrace, getFaultModeFromEnv } from './tunnelFaultInjection.js';
import {
  RegistryStore,
  getDefaultRegistry,
} from './tunnelRegistry.js';

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
 * Called when the last owned tunnel is disconnected and the agent process may have died.
 */
function resetNgrokModule(): void {
  ngrokModule = null;
}

const logger = new Logger({ module: 'tunnelManager' });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TunnelInfo {
  tunnelId: string;
  originalUrl: string;
  tunnelUrl: string;
  publicUrl: string;
  port: number;
  createdAt: number;
  lastAccessedAt: number;
  autoShutoffTimer?: NodeJS.Timeout;
  /** Whether THIS process created and owns the underlying ngrok session. */
  isOwned: boolean;
  /** Backend ngrok API key ID — revoked when this tunnel stops (owned only). */
  keyId?: string;
  /** Callback to revoke the backend key on stop (owned only). */
  revokeKey?: () => Promise<void>;
}

export interface TunnelResult {
  url: string;
  tunnelId?: string;
  isLocalhost: boolean;
}

// ── TunnelManager ─────────────────────────────────────────────────────────────

class TunnelManager {
  private activeTunnels = new Map<string, TunnelInfo>();
  private pendingTunnels = new Map<number, Promise<TunnelInfo>>();
  private initialized = false;
  private readonly TUNNEL_TIMEOUT_MS = 55 * 60 * 1000;
  /**
   * Backoff schedule (ms) between ngrok.connect() retry attempts. Bead ixh.
   * Exposed on the class so tests can override with short delays without
   * changing the public API or depending on jest fake timers.
   */
  public connectBackoffMs: number[] = [500, 1500];

  constructor(private readonly reg: RegistryStore = getDefaultRegistry()) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  async processUrl(
    url: string,
    authToken?: string,
    specificTunnelId?: string,
    keyId?: string,
    revokeKey?: () => Promise<void>,
  ): Promise<TunnelResult> {
    if (!isLocalhostUrl(url)) {
      return { url, isLocalhost: false };
    }

    const port = extractLocalhostPort(url);
    if (!port) {
      throw new Error(`Could not extract port from localhost URL: ${url}`);
    }

    if (!authToken) {
      throw new Error('Auth token required to create tunnel for localhost URL');
    }

    const tunnelId = specificTunnelId || uuidv4();
    return this.processPerPort(url, port, authToken, tunnelId, keyId, revokeKey);
  }

  /**
   * Return an active tunnel for the given local port, or undefined.
   * For borrowed tunnels, evicts the entry if the owning process has died.
   */
  getTunnelForPort(port: number): TunnelInfo | undefined {
    const existing = this.findTunnelByPort(port);
    if (!existing) return undefined;

    if (!existing.isOwned) {
      // Verify the owning process is still alive
      const entry = this.reg.read()[String(port)];
      if (!entry || !this.reg.isPidAlive(entry.ownerPid)) {
        this.activeTunnels.delete(existing.tunnelId);
        logger.info(`Evicted stale borrowed tunnel ${existing.tunnelId} (owner PID ${entry?.ownerPid} dead)`);
        return undefined;
      }
    }

    return existing;
  }

  touchTunnel(tunnelId: string): void {
    const tunnelInfo = this.activeTunnels.get(tunnelId);
    if (!tunnelInfo) return;

    // Refresh the shared registry entry so the owning process won't auto-shutoff
    // while we're actively using the tunnel (even if we're borrowing it).
    try {
      const registry = this.reg.read();
      const entry = registry[String(tunnelInfo.port)];
      if (entry) {
        entry.lastAccessedAt = Date.now();
        this.reg.write(registry);
      }
    } catch {
      // best-effort
    }

    this.resetTunnelTimer(tunnelInfo);
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

  getTunnelInfo(tunnelId: string): TunnelInfo | undefined {
    return this.activeTunnels.get(tunnelId);
  }

  getActiveTunnels(): TunnelInfo[] {
    return Array.from(this.activeTunnels.values());
  }

  async stopTunnel(tunnelId: string): Promise<void> {
    const tunnelInfo = this.activeTunnels.get(tunnelId);
    if (!tunnelInfo) {
      logger.warn(`Tunnel ${tunnelId} not found for cleanup`);
      return;
    }

    if (tunnelInfo.autoShutoffTimer) {
      clearTimeout(tunnelInfo.autoShutoffTimer);
    }
    this.activeTunnels.delete(tunnelId);

    if (!tunnelInfo.isOwned) {
      // Borrowed — just drop the local reference; owner manages the real tunnel
      logger.info(`Released borrowed tunnel reference: ${tunnelInfo.publicUrl}`);
      Telemetry.capture(TelemetryEvents.TUNNEL_STOPPED, { port: tunnelInfo.port, reason: 'released', isOwned: false });
      return;
    }

    // Owned — remove from shared registry, then disconnect + revoke
    try {
      const registry = this.reg.read();
      delete registry[String(tunnelInfo.port)];
      this.reg.write(registry);
    } catch {
      // best-effort
    }

    try {
      const ngrok = await getNgrok();
      await ngrok.disconnect(tunnelInfo.tunnelUrl);
      logger.info(`Cleaned up tunnel: ${tunnelInfo.publicUrl}`);
    } catch (error) {
      logger.warn(`ngrok.disconnect failed for tunnel ${tunnelId} (already cleaned up):`, error);
    }

    // If no owned tunnels remain, the ngrok agent process may have exited.
    // Reset module + init state so the next connect() bootstraps a fresh agent.
    const hasOwnedTunnels = Array.from(this.activeTunnels.values()).some(t => t.isOwned);
    if (!hasOwnedTunnels) {
      logger.info('No owned tunnels remain — resetting ngrok module for fresh init on next request');
      resetNgrokModule();
      this.initialized = false;
    }

    if (tunnelInfo.revokeKey) {
      tunnelInfo.revokeKey().catch((err) =>
        logger.warn(`Failed to revoke key for tunnel ${tunnelId}:`, err)
      );
    }
  }

  async stopAllTunnels(): Promise<void> {
    const ids = Array.from(this.activeTunnels.keys());
    await Promise.all(
      ids.map((id) =>
        this.stopTunnel(id).catch((err) =>
          logger.error(`Failed to stop tunnel ${id}:`, err)
        )
      )
    );
    logger.info(`Stopped ${ids.length} tunnel(s)`);
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
      timeUntilAutoShutoff: Math.max(0, tunnel.lastAccessedAt + this.TUNNEL_TIMEOUT_MS - now),
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

  // ── Per-port tunnel ─────────────────────────────────────────────────────────

  private async processPerPort(
    url: string,
    port: number,
    authToken: string,
    tunnelId: string,
    keyId?: string,
    revokeKey?: () => Promise<void>,
  ): Promise<TunnelResult> {
    // 1. Check local in-process map (handles owned + borrowed with liveness check)
    const existing = this.getTunnelForPort(port);
    if (existing) {
      logger.info(`Reusing existing tunnel for port ${port}: ${existing.publicUrl}`);
      Telemetry.capture(TelemetryEvents.TUNNEL_PROVISIONED, { port, how: 'reused' });
      return { url: existing.publicUrl, tunnelId: existing.tunnelId, isLocalhost: true };
    }

    // 2. Deduplicate concurrent creation requests for the same port
    const pending = this.pendingTunnels.get(port);
    if (pending) {
      // Bead 7qh Finding 2: our minted tunnelKey/keyId are now redundant — the
      // in-flight call owns the tunnel for this port. Revoke our key up-front
      // so it doesn't orphan on the backend. Failures are swallowed: we can't
      // let cleanup break the join.
      if (revokeKey) {
        revokeKey().catch((err) =>
          logger.warn(`Failed to revoke redundant key while joining pending tunnel for port ${port}:`, err),
        );
      }
      const info = await pending;
      return { url: info.publicUrl, tunnelId: info.tunnelId, isLocalhost: true };
    }

    // 3. Check cross-process registry — another MCP instance may own a tunnel
    const registry = this.reg.read();
    const regEntry = registry[String(port)];
    if (regEntry && this.reg.isPidAlive(regEntry.ownerPid)) {
      logger.info(`Borrowing tunnel from PID ${regEntry.ownerPid} for port ${port}: ${regEntry.publicUrl}`);
      const now = Date.now();
      const borrowed: TunnelInfo = {
        tunnelId: regEntry.tunnelId,
        originalUrl: url,
        tunnelUrl: regEntry.tunnelUrl,
        publicUrl: regEntry.publicUrl,
        port,
        createdAt: now,
        lastAccessedAt: now,
        isOwned: false,
      };
      this.activeTunnels.set(regEntry.tunnelId, borrowed);
      // Touch registry so the owner knows not to auto-shutoff
      regEntry.lastAccessedAt = now;
      this.reg.write(registry);
      this.resetTunnelTimer(borrowed);
      Telemetry.capture(TelemetryEvents.TUNNEL_PROVISIONED, { port, how: 'borrowed' });
      return { url: regEntry.publicUrl, tunnelId: regEntry.tunnelId, isLocalhost: true };
    }

    // 4. Create a new tunnel (this process becomes the owner)
    const creationPromise = this.createTunnel(url, port, tunnelId, authToken, keyId, revokeKey);
    this.pendingTunnels.set(port, creationPromise);

    let tunnelInfo: TunnelInfo;
    try {
      tunnelInfo = await creationPromise;
    } finally {
      this.pendingTunnels.delete(port);
    }

    return { url: tunnelInfo.publicUrl, tunnelId: tunnelInfo.tunnelId, isLocalhost: true };
  }

  private findTunnelByPort(port: number): TunnelInfo | undefined {
    for (const tunnel of this.activeTunnels.values()) {
      if (tunnel.port === port) return tunnel;
    }
    return undefined;
  }

  private async createTunnel(
    originalUrl: string,
    port: number,
    tunnelId: string,
    authToken: string,
    keyId?: string,
    revokeKey?: () => Promise<void>,
  ): Promise<TunnelInfo> {
    await this.ensureInitialized();

    const tunnelDomain = `${tunnelId}.ngrok.debugg.ai`;
    logger.info(`Creating tunnel for localhost:${port} (domain: ${tunnelDomain})`);

    const isHttpsLocal = originalUrl.startsWith('https:');
    const inDocker = process.env.DOCKER_CONTAINER === 'true';
    const dockerHost = 'host.docker.internal';

    // Bead fhg: force IPv4 loopback when running against localhost. ngrok's
    // default resolution of a bare port or "localhost" can pick IPv6 [::1]
    // first on macOS/modern OSes, but most dev servers (Next.js, Vite) bind
    // only to 127.0.0.1 — resulting in ngrok connect:refused + ERR_NGROK_8012
    // on the browser side with no actionable error back to the MCP caller.
    let localAddr: string;
    if (isHttpsLocal) {
      localAddr = inDocker ? `https://${dockerHost}:${port}` : `https://localhost:${port}`;
    } else {
      localAddr = inDocker ? `${dockerHost}:${port}` : `127.0.0.1:${port}`;
    }

    // Bead ixh: 3-attempt retry for ngrok.connect transient failures. Previously
    // only retried ONCE (with agent reset), which is insufficient against real
    // ngrok / network flakes (client-reported incident 2026-04-24).
    // - Attempt 1: fresh connect
    // - Attempt 2: after 500ms backoff, reset the ngrok agent module and retry
    //   (existing "agent died" recovery path)
    // - Attempt 3: after 1500ms backoff, retry with the already-reset agent
    // Auth-token errors short-circuit at any attempt — no point looping.
    const self = this;
    // Bead 42g: fault injection + trace. Only active when NODE_ENV !== 'production'
    // AND DEBUGG_TUNNEL_FAULT_MODE env var is set. Zero overhead when disabled.
    const faultMode = getFaultModeFromEnv();
    const faults = new FaultInjector(faultMode);
    const trace = new TunnelTrace();
    trace.emit('createTunnel.start', { port, tunnelId, hasFaultMode: !!faultMode });

    const connectWithRetry = async (): Promise<string> => {
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const BACKOFF_MS = self.connectBackoffMs; // bead ixh: test-overridable
      const MAX_ATTEMPTS = BACKOFF_MS.length + 1; // N sleeps between N+1 attempts
      const connectOpts = {
        proto: 'http' as const,
        addr: localAddr,
        hostname: tunnelDomain,
        authtoken: authToken,
      };

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
    };

    try {
      const tunnelUrl = await connectWithRetry();

      const publicUrl = generateTunnelUrl(originalUrl, tunnelId);
      const now = Date.now();

      const tunnelInfo: TunnelInfo = {
        tunnelId,
        originalUrl,
        tunnelUrl,
        publicUrl,
        port,
        createdAt: now,
        lastAccessedAt: now,
        isOwned: true,
        keyId,
        revokeKey,
      };

      this.activeTunnels.set(tunnelId, tunnelInfo);

      // Register in shared cross-process registry
      try {
        const registry = this.reg.read();
        registry[String(port)] = {
          tunnelId,
          publicUrl,
          tunnelUrl,
          port,
          ownerPid: process.pid,
          lastAccessedAt: now,
        };
        this.reg.write(registry);
      } catch {
        // best-effort
      }

      this.resetTunnelTimer(tunnelInfo);

      trace.emit('createTunnel.success', { tunnelId, publicUrl });
      logger.info(`Tunnel created: ${publicUrl} → localhost:${port}`);
      Telemetry.capture(TelemetryEvents.TUNNEL_PROVISIONED, { port, how: 'created' });
      return tunnelInfo;

    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      trace.emit('createTunnel.fail', { message: msg.slice(0, 200) });
      // Bead 42g: when the trace captured meaningful timing info, log it at
      // WARN so operators can post-mortem. Keeping it out of the thrown error
      // text so we don't leak internals to users.
      logger.warn(`Tunnel lifecycle trace (fail path):\n${trace.format()}`);
      if (msg.includes('authtoken')) {
        throw new Error(`Failed to create tunnel: invalid auth token. ${msg}`);
      }
      throw new Error(`Failed to create tunnel: ${msg}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

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

  private resetTunnelTimer(tunnelInfo: TunnelInfo): void {
    if (tunnelInfo.autoShutoffTimer) clearTimeout(tunnelInfo.autoShutoffTimer);
    tunnelInfo.lastAccessedAt = Date.now();
    tunnelInfo.autoShutoffTimer = setTimeout(async () => {
      // For owned tunnels: if another process recently touched the registry entry,
      // reset the timer rather than disconnecting — that process is still using it.
      if (tunnelInfo.isOwned) {
        try {
          const entry = this.reg.read()[String(tunnelInfo.port)];
          if (entry && Date.now() - entry.lastAccessedAt < this.TUNNEL_TIMEOUT_MS) {
            logger.info(`Tunnel ${tunnelInfo.tunnelId} accessed by another process — extending lifetime`);
            this.resetTunnelTimer(tunnelInfo);
            return;
          }
        } catch {
          // best-effort; proceed with shutoff
        }
      }
      logger.info(`Auto-shutting down tunnel ${tunnelInfo.tunnelId} after inactivity`);
      Telemetry.capture(TelemetryEvents.TUNNEL_STOPPED, { port: tunnelInfo.port, reason: 'auto-shutoff', isOwned: tunnelInfo.isOwned });
      await this.stopTunnel(tunnelInfo.tunnelId).catch((err) =>
        logger.error(`Failed to auto-shutdown tunnel ${tunnelInfo.tunnelId}:`, err)
      );
    }, this.TUNNEL_TIMEOUT_MS);
  }
}

const tunnelManager = new TunnelManager();

export { tunnelManager };
export default TunnelManager;
