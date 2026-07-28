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
import { isLocalhostUrl, extractLocalhostPort, generateTunnelUrl, retargetTunnelUrl } from '../../utils/urlParser.js';
import { v4 as uuidv4 } from 'uuid';
import { FaultInjector, TunnelTrace, getFaultModeFromEnv } from './tunnelFaultInjection.js';
import {
  RegistryStore,
  RegistryEntry,
  RegistryData,
  getDefaultRegistry,
} from './tunnelRegistry.js';
import { startAgentSession, AgentSessionStarter } from './ngrokAgentSession.js';
import { getDefaultInspector, TunnelInspector } from './ngrokAgentInspector.js';

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
  /**
   * Idle window before an owned tunnel auto-shuts-off. THE constant of this
   * class: every other lifetime below is derived from it, because they are all
   * answering the same question — "could this tunnel still be alive?" — and
   * when they answered it differently they cost real money (bead y7x6).
   *
   * Public so timer tests can run in milliseconds instead of 55 minutes,
   * matching the `connectBackoffMs` / `agentSessionStarter` precedent.
   */
  public idleTimeoutMs = 55 * 60 * 1000;
  /**
   * Bead `3th`: registry-entry freshness window. An entry not touched within
   * this many ms is treated as stale even if its owner PID is alive — defends
   * against PID-reuse (OS reassigns dead-owner's PID to a different process).
   *
   * Bead `y7x6`: this was a hard-coded 30 minutes while tunnels lived for 55,
   * so between T+30 and T+55 an entry was judged unusable while the tunnel it
   * named was alive and billing. The next request provisioned a duplicate and
   * OVERWROTE the entry, orphaning the original: a systematic double-bill on a
   * 25-minute-wide window. Deriving it from the idle timeout is the fix, and
   * it is the derivation — not the number — that matters, because it makes the
   * two impossible to drift apart again.
   *
   * No guard band is subtracted. A band would just re-open a narrower version
   * of the same window, and the T+55 boundary is already handled: a borrower
   * writes `lastAccessedAt` before the owner's timer fires, and the owner then
   * extends rather than shutting down.
   */
  private get registryFreshnessTtlMs(): number {
    return this.idleTimeoutMs;
  }
  /**
   * Bead `mdp`: prune-on-startup eviction window. Entries older than this OR
   * with dead owner PID get swept out when TunnelManager initializes.
   *
   * Also derived, for the same reason: an entry older than the idle timeout
   * names a tunnel that has already auto-shut-off, and one that has NOT is
   * recovered by re-adoption (bead lc62) rather than by keeping a longer
   * threshold here. Pruning something `isEntryUsable` already rejects costs
   * nothing; the danger was never prune's window, it was that nothing put a
   * live tunnel back.
   */
  private get registryPruneThresholdMs(): number {
    return this.idleTimeoutMs;
  }
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
   * Bead lc62: where we learn which tunnels are actually alive on this machine.
   * Overridable so tests drive a fake agent API instead of loopback HTTP.
   */
  public tunnelInspector: TunnelInspector = getDefaultInspector();
  /** Whether the ngrok agent's client session is established (bead pqgj). */
  private agentSessionReady = false;
  /** In-flight session bootstrap, so concurrent tunnels wait on one spawn. */
  private agentSessionPromise: Promise<void> | null = null;
  /** Memoized one-shot reconcile against the local ngrok agents (bead lc62). */
  private reconcilePromise: Promise<void> | null = null;

  constructor(private readonly reg: RegistryStore = getDefaultRegistry()) {
    // Bead `mdp`: sweep stale entries on startup so the registry doesn't grow
    // unboundedly across MCP processes that exited without stopAllTunnels
    // (SIGKILL / crash). Best-effort — no-op registries don't actually prune.
    //
    // Bead lc62: this sweep deletes map keys, which cannot stop a tunnel, so a
    // pruned-but-live tunnel becomes an invisible billing line. Making prune
    // tear tunnels down would be far worse — two billed hours for every idle
    // gap, on exactly the days-long sessions this design exists to serve — so
    // recovery is handled the other way round, by reconcileWithLocalAgents()
    // putting live tunnels BACK. Prune stays cheap, synchronous, and harmless.
    try {
      const result = this.reg.prune({ staleAfterMs: this.registryPruneThresholdMs });
      if (result.pruned > 0) {
        logger.info(`Pruned ${result.pruned} stale registry entries on startup (${result.remaining} remaining)`);
      }
    } catch (err) {
      logger.warn(`Registry prune-on-startup failed (non-fatal): ${err}`);
    }
  }

  /**
   * Bead `3th`: freshness check used at borrow sites. Returns true if the
   * entry is BOTH owner-alive AND touched recently enough to trust.
   */
  private isEntryUsable(entry: RegistryEntry, nowMs: number = Date.now()): boolean {
    return (
      this.reg.isPidAlive(entry.ownerPid) &&
      (nowMs - entry.lastAccessedAt) <= this.registryFreshnessTtlMs
    );
  }

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
      // Verify the owning process is still alive AND the entry is fresh
      // (lastAccessedAt within registryFreshnessTtlMs — defends against
      // PID-reuse per bead 3th).
      const entry = this.reg.read()[String(port)];
      if (!entry || !this.isEntryUsable(entry)) {
        this.activeTunnels.delete(existing.tunnelId);
        const reason = !entry
          ? 'no registry entry'
          : !this.reg.isPidAlive(entry.ownerPid)
            ? `owner PID ${entry.ownerPid} dead`
            : `entry stale (last accessed ${Math.round((Date.now() - entry.lastAccessedAt) / 1000)}s ago)`;
        logger.info(`Evicted stale borrowed tunnel ${existing.tunnelId} (${reason})`);
        return undefined;
      }
    }

    return existing;
  }

  /**
   * Evict a tunnel that a health probe PROVED dead (e.g. ERR_NGROK_3200) so no
   * session borrows the corpse again (bead k34o).
   *
   * OWNED: delegate to stopTunnel — it already removes the registry entry,
   * disconnects, revokes the key, and resets the agent. (Self-heals after one
   * failure, which already worked.)
   *
   * BORROWED (the actual gap): stopTunnel only drops our local ref and leaves the
   * SHARED registry entry, so every other session keeps re-borrowing the dead
   * tunnel for up to the 30-min freshness TTL. Here we also evict the shared
   * entry — guarded by tunnelId so a replacement another session just provisioned
   * for the same port is never removed. Best-effort, never throws.
   */
  async markTunnelDead(port: number, tunnelId: string): Promise<void> {
    const local = this.activeTunnels.get(tunnelId);
    if (local?.isOwned) {
      await this.stopTunnel(tunnelId).catch(() => { /* dead already; best-effort */ });
      return;
    }
    // Borrowed or no longer local — drop any local ref, then evict the shared entry.
    if (local?.autoShutoffTimer) clearTimeout(local.autoShutoffTimer);
    this.activeTunnels.delete(tunnelId);
    try {
      const registry = this.reg.read();
      if (registry[String(port)]?.tunnelId === tunnelId) {
        delete registry[String(port)];
        this.reg.write(registry);
        logger.info(`Evicted dead borrowed tunnel ${tunnelId} for port ${port} from shared registry`);
      }
    } catch {
      // best-effort — a failed eviction just means the next call re-probes and re-evicts
    }
  }

  /**
   * Mark a tunnel as in-use: refresh the shared registry entry so the owner
   * does not auto-shut-off underneath us, and reset the local idle timer.
   *
   * Bead lc62 — two changes here, both about the registry telling the truth:
   *
   * 1. The refresh is now scoped to OUR tunnelId. It used to refresh whatever
   *    entry held our port, so using tunnel A kept tunnel B's entry alive after
   *    B had replaced A on that port.
   * 2. If we OWN the tunnel and the entry has gone missing, we put it back.
   *    Nothing did this before: prune (or a registry the process could not see,
   *    bead fcbm) deleted the entry, and since the in-process reuse path never
   *    wrote to the registry, the tunnel stayed live, stayed billing, and
   *    stayed permanently invisible to every other MCP on the machine. One file
   *    write makes that self-heal, and it cannot churn a tunnel because it only
   *    ever ADDS the entry for a tunnel this process is holding open.
   *
   * A foreign entry — same port, different tunnelId — is left completely alone.
   * That is another process's live tunnel; overwriting it would displace it.
   */
  touchTunnel(tunnelId: string): void {
    const tunnelInfo = this.activeTunnels.get(tunnelId);
    if (!tunnelInfo) return;

    try {
      const registry = this.reg.read();
      const key = String(tunnelInfo.port);
      const entry = registry[key];
      if (entry?.tunnelId === tunnelInfo.tunnelId) {
        entry.lastAccessedAt = Date.now();
        this.reg.write(registry);
      } else if (!entry && tunnelInfo.isOwned) {
        registry[key] = this.registryEntryFor(tunnelInfo);
        this.reg.write(registry);
        logger.info(
          `Re-registered owned tunnel ${tunnelInfo.tunnelId} for port ${tunnelInfo.port} — ` +
          'its registry entry had gone missing while the tunnel was still live (bead lc62).',
        );
      }
    } catch {
      // best-effort
    }

    this.resetTunnelTimer(tunnelInfo);
  }

  /** The shared-registry view of a tunnel this process owns. */
  private registryEntryFor(tunnelInfo: TunnelInfo): RegistryEntry {
    return {
      tunnelId: tunnelInfo.tunnelId,
      publicUrl: tunnelInfo.publicUrl,
      tunnelUrl: tunnelInfo.tunnelUrl,
      port: tunnelInfo.port,
      ownerPid: process.pid,
      lastAccessedAt: Date.now(),
    };
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

    // Owned — remove from shared registry, then disconnect + revoke.
    // Guarded by tunnelId (bead lc62, same reasoning as the auto-shutoff check
    // and markTunnelDead): if a replacement already holds this port's entry,
    // deleting it would strand ITS live tunnel and buy the next caller a
    // duplicate. Only ever remove the entry that names the tunnel we are
    // actually stopping.
    try {
      const registry = this.reg.read();
      const key = String(tunnelInfo.port);
      if (registry[key]?.tunnelId === tunnelInfo.tunnelId) {
        delete registry[key];
        this.reg.write(registry);
      }
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
      // Bead zmc9: retarget to THIS caller's path; publicUrl carries the creator's.
      const url_ = retargetTunnelUrl(existing.tunnelUrl, url);
      // Bead lc62: reuse used to return straight from the in-process map without
      // touching the registry at all, so a tunnel could be in constant use and
      // still look abandoned to every other MCP — and its own idle timer kept
      // counting down. touchTunnel refreshes (or restores) the shared entry and
      // resets that timer, which is what "this tunnel is in use" should mean.
      this.touchTunnel(existing.tunnelId);
      logger.info(`Reusing existing tunnel for port ${port}: ${url_}`);
      Telemetry.capture(TelemetryEvents.TUNNEL_PROVISIONED, { port, how: 'reused' });
      return { url: url_, tunnelId: existing.tunnelId, isLocalhost: true };
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
      // Bead zmc9: retarget to THIS caller's path, not the in-flight creator's.
      return { url: retargetTunnelUrl(info.tunnelUrl, url), tunnelId: info.tunnelId, isLocalhost: true };
    }

    // 3. Check cross-process registry — another MCP instance may own a tunnel.
    //    Borrow only if the entry is fresh (PID alive AND touched within
    //    registryFreshnessTtlMs — defends against PID-reuse, bead 3th).
    const registry = this.reg.read();
    const regEntry = registry[String(port)];
    if (regEntry && this.isEntryUsable(regEntry)) {
      const borrowed = this.borrowRegistryEntry(regEntry, url, registry);
      // Bead zmc9: retarget to THIS caller's path; regEntry.publicUrl carries the
      // owning PID's creating-call path — replaying it is the cross-session poison.
      return { url: retargetTunnelUrl(borrowed.tunnelUrl, url), tunnelId: borrowed.tunnelId, isLocalhost: true };
    }

    // 4. Nothing to reuse. Publish the pending promise SYNCHRONOUSLY — every
    //    check above is synchronous precisely so a second caller arriving in
    //    this same tick joins us rather than buying a second hour — and do the
    //    slow work (agent reconcile, then connect) inside it.
    const creationPromise = this.adoptOrCreateTunnel(url, port, tunnelId, authToken, keyId, revokeKey);
    this.pendingTunnels.set(port, creationPromise);

    let tunnelInfo: TunnelInfo;
    try {
      tunnelInfo = await creationPromise;
    } finally {
      this.pendingTunnels.delete(port);
    }

    // A tunnel we just created carries this caller's path in publicUrl; an
    // ADOPTED one carries someone else's, so retarget (bead zmc9).
    const resolvedUrl = tunnelInfo.isOwned
      ? tunnelInfo.publicUrl
      : retargetTunnelUrl(tunnelInfo.tunnelUrl, url);
    return { url: resolvedUrl, tunnelId: tunnelInfo.tunnelId, isLocalhost: true };
  }

  /**
   * Take a live registry entry into this process as a BORROWED tunnel, and
   * stamp it as touched so its owner does not auto-shut-off underneath us.
   */
  private borrowRegistryEntry(entry: RegistryEntry, url: string, registry: RegistryData): TunnelInfo {
    logger.info(`Borrowing tunnel from PID ${entry.ownerPid} for port ${entry.port}: ${entry.publicUrl}`);
    const now = Date.now();
    const borrowed: TunnelInfo = {
      tunnelId: entry.tunnelId,
      originalUrl: url,
      tunnelUrl: entry.tunnelUrl,
      publicUrl: entry.publicUrl,
      port: entry.port,
      createdAt: now,
      lastAccessedAt: now,
      isOwned: false,
    };
    this.activeTunnels.set(entry.tunnelId, borrowed);
    entry.lastAccessedAt = now;
    try {
      this.reg.write(registry);
    } catch {
      // best-effort
    }
    this.resetTunnelTimer(borrowed);
    Telemetry.capture(TelemetryEvents.TUNNEL_PROVISIONED, { port: entry.port, how: 'borrowed' });
    return borrowed;
  }

  /**
   * Last stop before spending a billed hour (bead lc62).
   *
   * The registry says there is nothing to reuse for this port. Before believing
   * it, ask the local ngrok agents what is ACTUALLY running: a tunnel whose
   * owner was SIGKILLed, or whose entry got pruned or written to a registry
   * this process could not see, is still open and still billing, and the
   * registry is simply wrong about it. Re-adopting one costs a loopback GET;
   * not adopting it costs an hour for the replacement plus the remaining hour
   * of the orphan nobody is using.
   *
   * Reaping orphans is deliberately NOT done here. Once they can be re-adopted
   * an orphan pointing at a live port is an asset, and killing it only
   * guarantees we buy that hour again later.
   */
  private async adoptOrCreateTunnel(
    url: string,
    port: number,
    tunnelId: string,
    authToken: string,
    keyId?: string,
    revokeKey?: () => Promise<void>,
  ): Promise<TunnelInfo> {
    await this.reconcileWithLocalAgents();

    const registry = this.reg.read();
    const entry = registry[String(port)];
    if (entry && this.isEntryUsable(entry)) {
      logger.info(`Adopted live tunnel ${entry.tunnelId} for port ${port} instead of provisioning a new one`);
      return this.borrowRegistryEntry(entry, url, registry);
    }

    return this.createTunnel(url, port, tunnelId, authToken, keyId, revokeKey);
  }

  /**
   * Reconcile the shared registry against the tunnels the local ngrok agents
   * report (bead lc62). Runs at most once per process, lazily — on the first
   * request that would otherwise provision — so importing this module never
   * touches the network and a process that only ever borrows never pays for it.
   *
   * ADD-ONLY, and that is the whole safety argument. This can create an entry
   * or refresh an unusable one; it can never delete or invalidate anything. So
   * an agent that is down, a scan that misses the right port, or a parse that
   * fails all degrade to "learned nothing" and leave behaviour exactly as it is
   * today. Nothing this function can get wrong is able to cost a re-provision.
   *
   * A usable entry is never disturbed, even by a live tunnel claiming the same
   * port: that entry is somebody's working tunnel and displacing it would
   * strand a paid-for session.
   */
  private reconcileWithLocalAgents(): Promise<void> {
    if (!this.reconcilePromise) {
      this.reconcilePromise = (async () => {
        const live = await this.tunnelInspector.listLiveTunnels();
        if (live.length === 0) return;

        const registry = this.reg.read();
        const adopted: string[] = [];
        for (const tunnel of live) {
          const key = String(tunnel.port);
          const entry = registry[key];
          // Somebody's working entry — never touch it, even to "correct" it.
          if (entry && this.isEntryUsable(entry)) continue;
          registry[key] = {
            tunnelId: tunnel.tunnelId,
            publicUrl: tunnel.publicUrl,
            tunnelUrl: tunnel.publicUrl,
            port: tunnel.port,
            // We are not the ngrok owner and never claim to be — TunnelInfo for
            // this entry is always built with isOwned:false. ownerPid is the
            // registry's liveness proxy, and pointing it at a live process is
            // what makes the entry borrowable at all.
            ownerPid: process.pid,
            lastAccessedAt: Date.now(),
          };
          adopted.push(`${tunnel.tunnelId}→${tunnel.port}`);
        }
        if (adopted.length > 0) {
          this.reg.write(registry);
          logger.info(
            `Re-adopted ${adopted.length} live ngrok tunnel(s) the registry had lost: ${adopted.join(', ')}. ` +
            'Each one saves provisioning a duplicate for a port that is already served.',
          );
        }
      })().catch((err) => {
        // An inspector failure must never block tunnelling — it only ever had
        // the power to save us money, never to authorise anything.
        logger.debug(`ngrok agent reconcile unavailable (non-fatal): ${err}`);
      });
    }
    return this.reconcilePromise;
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
    // Bead 42g: fault injection + trace. Only active when NODE_ENV !== 'production'
    // AND DEBUGG_TUNNEL_FAULT_MODE env var is set. Zero overhead when disabled.
    const faultMode = getFaultModeFromEnv();
    const faults = new FaultInjector(faultMode);
    const trace = new TunnelTrace();
    trace.emit('createTunnel.start', { port, tunnelId, hasFaultMode: !!faultMode });

    const connectWithRetry = async (): Promise<string> => {
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

  private resetTunnelTimer(tunnelInfo: TunnelInfo): void {
    if (tunnelInfo.autoShutoffTimer) clearTimeout(tunnelInfo.autoShutoffTimer);
    tunnelInfo.lastAccessedAt = Date.now();
    tunnelInfo.autoShutoffTimer = setTimeout(async () => {
      // For owned tunnels: if another process recently touched the registry entry,
      // reset the timer rather than disconnecting — that process is still using it.
      //
      // Bead lc62: the entry has to be OURS. This lookup is keyed by port, and
      // the check used to stop at the timestamp, so once a replacement tunnel
      // took over the port the displaced tunnel read the replacement's activity
      // as its own and extended itself — forever, since every extension found
      // the entry fresh again. That is what turned a 55-minute mistake into a
      // multi-day one: an orphan nobody could reach, billing indefinitely.
      // Comparing tunnelId makes an orphan simply time out, 55 idle minutes
      // after the last time anyone actually used IT.
      if (tunnelInfo.isOwned) {
        try {
          const entry = this.reg.read()[String(tunnelInfo.port)];
          if (
            entry &&
            entry.tunnelId === tunnelInfo.tunnelId &&
            Date.now() - entry.lastAccessedAt < this.idleTimeoutMs
          ) {
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
    }, this.idleTimeoutMs);
  }
}

const tunnelManager = new TunnelManager();

export { tunnelManager };
export default TunnelManager;
