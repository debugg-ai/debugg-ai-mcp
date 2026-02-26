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

    let localAddr: string | number;
    if (isHttpsLocal) {
      localAddr = inDocker ? `https://${dockerHost}:${port}` : `https://localhost:${port}`;
    } else {
      localAddr = inDocker ? `${dockerHost}:${port}` : port;
    }

    try {
      const ngrok = await getNgrok();
      const tunnelUrl = await ngrok.connect({
        proto: 'http' as const,
        addr: localAddr,
        hostname: tunnelDomain,
        authtoken: authToken,
      });

      if (!tunnelUrl) throw new Error('ngrok.connect() returned empty URL');

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

      logger.info(`Tunnel created: ${publicUrl} → localhost:${port}`);
      Telemetry.capture(TelemetryEvents.TUNNEL_PROVISIONED, { port, how: 'created' });
      return tunnelInfo;

    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
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
