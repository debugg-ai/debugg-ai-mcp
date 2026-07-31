/**
 * Per-session port route lock — services/caddy/portLock.ts
 *
 * See docs/local-tunnel-multiplexer-architecture-2026-07-31.md §2.4 for the
 * full design rationale; this file is a direct implementation of it, not a
 * reinterpretation. Read that section before changing anything here.
 *
 * One Caddy instance holds exactly one dynamic upstream (§2.2). Two calls
 * targeting the SAME port can dispatch fully concurrently (no repoint
 * needed — Caddy is already pointed the right way). Two calls targeting
 * DIFFERENT ports must fully serialize: repoint -> dispatch -> release, for
 * the WHOLE tool call, not just the repoint — a call can hold the tunnel
 * for minutes, and a mid-flight repoint-away would silently misdirect a
 * live browser session into the wrong local app.
 *
 * This lock is instantiated ONCE PER SESSION (per `TunnelInfo`, §2.3), never
 * as a process-wide singleton — a global lock would serialize unrelated
 * callers on totally different Caddy instances (§2.1: one process can host
 * N session keys in HTTP mode, each with its own Caddy instance).
 *
 * The generation identity is `{port, isHttpsLocal}`, not `port` alone — a
 * same-port-but-flipped-`isHttpsLocal` request needs a real repoint too,
 * matching `CaddyProxy.setUpstream`'s own idempotency check (see
 * services/caddy/caddyProxy.ts).
 *
 * Race fix this file exists to encode (§2.4 "Race fix" subsection): EVERY
 * claimer of a generation — whether it creates it or joins it — awaits the
 * exact SAME `readyPromise` (the one real `applyUpstream` call for that
 * generation) before its handle resolves. A synchronously-resolved handle
 * for a joiner would let dispatch start before the repoint is confirmed, or
 * even after it has failed. See `claim()` and §3.4's three-caller walkthrough.
 *
 * "No forced release, ever" (§4): `maxHoldMs` is an OBSERVABILITY-ONLY
 * watchdog. Force-releasing a lock while a legitimately slow call is STILL
 * ACTUALLY USING the port is exactly the traffic-misdirection failure this
 * whole architecture exists to prevent. The watchdog only logs + telemeters;
 * it never clears `gen`.
 */

import { logger } from '../../utils/logger.js';
import { Telemetry, TelemetryEvents } from '../../utils/telemetry.js';
import type { UpstreamTarget } from './caddyProxy.js';

export type { UpstreamTarget };

// ── Public types ─────────────────────────────────────────────────────────────

/** Returned by `PortLock.acquire()`. Call `release()` exactly once, from the
 *  caller's own `finally` block, when the whole tool call is done with this
 *  port — not merely when the repoint has landed. */
export interface PortRouteHandle {
  readonly port: number;
  readonly callId: string;
  release: () => void;
}

/** Delivered to `onWaitProgress` while a different-port caller is queued.
 *  The caller (utils/tunnelContext.ts's `acquirePortRoute`, per the doc's
 *  §2.4 hook points) is responsible for turning this into an actual MCP
 *  progress notification with whatever `progress`/`total` numbers make
 *  sense for the surrounding tool call — this type deliberately does not
 *  presume any progress-bar shape. */
export interface PortWaitInfo {
  /** The port this caller is waiting to route to. */
  targetPort: number;
  /** The port currently occupying the shared route, blocking this caller. */
  blockingPort: number;
  /** Milliseconds elapsed since this caller was queued. */
  waitedMs: number;
}

export interface PortLockAcquireOptions {
  /** Unique identifier for this call — used for holder bookkeeping and to
   *  disambiguate log/telemetry lines. Callers already generate a per-call
   *  id for other purposes (e.g. abort wiring); reuse it here. */
  callId: string;
  /** When this fires while the call is still QUEUED (not yet running), the
   *  wait is abandoned cleanly and `acquire()` rejects with
   *  `PortLockAbortedError`. Once a call has been promoted/claimed, its own
   *  abort signal is no longer this lock's concern (§2.4: "abort-signal
   *  propagation for queued-but-not-yet-running callers" only). */
  signal?: AbortSignal;
  /** Invoked on a `waitTickMs` ticker while queued behind a different-port
   *  holder. Never invoked for same-port joins (those are never queued). A
   *  throwing/rejecting callback is caught and logged — it can never break
   *  the lock itself. */
  onWaitProgress?: (info: PortWaitInfo) => Promise<void>;
}

// ── Errors (house style: named subclasses of Error — see
//    services/tunnels.ts's TunnelProvisionError for the pattern) ────────────

/** A different-port caller waited past `maxWaitMs` (default 20 min — chosen
 *  to comfortably exceed check_app_in_browser's ~720s worst-case backend
 *  budget plus retry overhead) without the route becoming free. */
export class PortRouteQueueTimeoutError extends Error {
  readonly targetPort: number;
  readonly blockingPort: number | undefined;
  readonly waitedMs: number;

  constructor(targetPort: number, blockingPort: number | undefined, waitedMs: number) {
    const blockingSuffix = blockingPort !== undefined ? ` (currently routed to port ${blockingPort})` : '';
    super(
      `Timed out after ${waitedMs}ms waiting for the shared local tunnel route to become ` +
        `available for port ${targetPort}${blockingSuffix}`,
    );
    this.name = 'PortRouteQueueTimeoutError';
    this.targetPort = targetPort;
    this.blockingPort = blockingPort;
    this.waitedMs = waitedMs;
  }
}

/** A queued (not-yet-running) caller's `AbortSignal` fired before it was
 *  promoted. Never thrown for a call that has already been claimed/promoted
 *  — see the class doc comment above `PortLock`. */
export class PortLockAbortedError extends Error {
  readonly callId: string;
  readonly targetPort: number;

  constructor(callId: string, targetPort: number) {
    super(`Call ${callId} was aborted while waiting for the shared local tunnel route to port ${targetPort}`);
    this.name = 'PortLockAbortedError';
    this.callId = callId;
    this.targetPort = targetPort;
  }
}

/** The `applyUpstream` (i.e. `CaddyProxy.setUpstream`) call backing a
 *  generation failed. Every claimer of that generation — the one that
 *  created it and every joiner — rejects with this. The lock itself is
 *  never left wedged: the generation is torn down and the next queued
 *  waiter (if any) is promoted (see `claim()`'s catch branch). */
export class CaddyRepointError extends Error {
  readonly targetPort: number;

  constructor(targetPort: number, cause: unknown) {
    super(`Failed to repoint the shared local tunnel route to port ${targetPort}: ${describeCause(cause)}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = 'CaddyRepointError';
    this.targetPort = targetPort;
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

// ── Internal bookkeeping ─────────────────────────────────────────────────────

interface Generation {
  target: UpstreamTarget;
  refCount: number;
  holders: Set<string>;
  claimedAt: number;
  /** The in-flight (or already-settled) `applyUpstream()` call for `target`.
   *  EVERY claimer — first or joiner — awaits this exact promise object
   *  before its handle resolves. This is what makes the race fix real: a
   *  joiner can never resolve ahead of the repoint it depends on. */
  readyPromise: Promise<void>;
  watchdogTimer?: NodeJS.Timeout;
}

interface QueueEntry {
  target: UpstreamTarget;
  callId: string;
  enqueuedAt: number;
  resolve: (handle: PortRouteHandle) => void;
  reject: (err: Error) => void;
  onWaitProgress?: (info: PortWaitInfo) => Promise<void>;
  signal?: AbortSignal;
  timeoutTimer?: NodeJS.Timeout;
  tickTimer?: NodeJS.Timeout;
  onAbort?: () => void;
}

function sameTarget(a: UpstreamTarget, b: UpstreamTarget): boolean {
  return a.port === b.port && Boolean(a.isHttpsLocal) === Boolean(b.isHttpsLocal);
}

// ── PortLock ─────────────────────────────────────────────────────────────────

export class PortLock {
  private gen: Generation | null = null;
  private queue: QueueEntry[] = [];

  /** Above check_app_in_browser's ~720s worst-case backend budget + retry
   *  overhead (§2.4). Public so tests/callers can tune it. */
  public maxWaitMs = 20 * 60 * 1000;
  /** OBSERVABILITY-ONLY watchdog ceiling — never force-releases. See the
   *  file-level doc comment and §4's "no forced release, ever" decision. */
  public maxHoldMs = 25 * 60 * 1000;
  public waitTickMs = 3000;

  /** `applyUpstream` is the caller's binding to `CaddyProxy.setUpstream` for
   *  THIS session's Caddy instance, e.g. `(t) => caddy.setUpstream(t)`
   *  (§2.3's `createSessionTunnel`). The lock never imports/constructs a
   *  `CaddyProxy` itself — it only knows how to serialize calls to one. */
  constructor(private readonly applyUpstream: (t: UpstreamTarget) => Promise<void>) {}

  /**
   * Acquire the shared route for `target`. Resolves once Caddy is CONFIRMED
   * pointed at `target` (the repoint's PATCH has actually completed) —
   * never before. Same-target callers join for free (zero additional
   * admin-API calls, zero added wait once that generation's repoint has
   * already resolved). Different-target callers block here — not just
   * during the repoint — until the current holder(s) release.
   */
  async acquire(target: UpstreamTarget, opts: PortLockAcquireOptions): Promise<PortRouteHandle> {
    if (opts.signal?.aborted) {
      throw new PortLockAbortedError(opts.callId, target.port);
    }

    // Synchronous decision, no `await` before the claim starts — this is
    // what keeps the cross-tunnel dedup/joining logic race-free (§2.4).
    if (this.gen === null || sameTarget(this.gen.target, target)) {
      return this.claim(target, opts.callId);
    }

    return new Promise<PortRouteHandle>((resolve, reject) => {
      const entry: QueueEntry = {
        target,
        callId: opts.callId,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        onWaitProgress: opts.onWaitProgress,
        signal: opts.signal,
      };
      this.queue.push(entry);

      entry.timeoutTimer = setTimeout(() => {
        const blockingPort = this.gen?.target.port;
        const waitedMs = Date.now() - entry.enqueuedAt;
        this.removeFromQueue(entry);
        reject(new PortRouteQueueTimeoutError(target.port, blockingPort, waitedMs));
      }, this.maxWaitMs);

      entry.onAbort = () => {
        const removed = this.removeFromQueue(entry);
        // Only reject if this entry was still actually queued — a call that
        // was already promoted has had its abort listener unregistered by
        // promoteNextWaiter (see clearWaitTimers there), so onAbort firing
        // after promotion should be unreachable; this guard just makes that
        // unreachability failure-safe instead of a double-settle.
        if (removed) reject(new PortLockAbortedError(entry.callId, target.port));
      };
      opts.signal?.addEventListener('abort', entry.onAbort, { once: true });

      if (opts.onWaitProgress) this.startTicker(entry);
    });
  }

  /**
   * Claims a slot on the current generation, creating one if needed. Every
   * code path through here — new generation or joining an existing one —
   * ends in `await gen.readyPromise` before returning a handle. This is the
   * §2.4 race fix: a joiner's `refCount`/`holders` reservation happens
   * synchronously (before any `await`), so a same-target racer arriving
   * between generation-creation and the first `await` still joins the one
   * in-flight `applyUpstream` call instead of triggering a second one — but
   * it still has to wait for that exact call to settle before it gets a
   * handle back.
   */
  private async claim(target: UpstreamTarget, callId: string): Promise<PortRouteHandle> {
    let gen = this.gen;
    if (gen === null) {
      const readyPromise = this.applyUpstream(target); // fired NOW, not awaited yet
      gen = { target, refCount: 0, holders: new Set(), claimedAt: Date.now(), readyPromise };
      this.gen = gen; // <-- visible to same-tick joiners before we suspend below
      // Real per-claimer handling happens in each claimer's own catch block
      // below; this just prevents an unhandled-rejection warning on the
      // shared promise itself.
      gen.readyPromise.catch(() => {});
      this.armWatchdog(gen);
    }

    // Reserve BEFORE awaiting: a joiner that calls claim() while
    // gen.readyPromise is still pending sees `this.gen` already set (from
    // the branch above) and skips straight to this reservation + the SAME
    // await — never a second PATCH/setUpstream call.
    gen.refCount++;
    gen.holders.add(callId);

    try {
      await gen.readyPromise; // every claimer — first AND joiners — wait HERE
    } catch (err) {
      gen.holders.delete(callId);
      gen.refCount--;
      if (gen.refCount === 0 && this.gen === gen) {
        this.clearWatchdog(gen);
        this.gen = null;
        this.promoteNextWaiter();
      }
      throw new CaddyRepointError(target.port, err);
    }

    return { port: target.port, callId, release: () => this.release(target, callId) };
  }

  private release(target: UpstreamTarget, callId: string): void {
    if (!this.gen || !sameTarget(this.gen.target, target) || !this.gen.holders.delete(callId)) {
      logger.warn(`portLock.release ignored — no matching holder (port=${target.port} callId=${callId})`);
      return;
    }
    if (--this.gen.refCount > 0) return;

    const finishedGen = this.gen;
    this.clearWatchdog(finishedGen);
    this.gen = null;
    this.promoteNextWaiter();
  }

  private promoteNextWaiter(): void {
    if (this.queue.length === 0) return;
    const front = this.queue.shift()!;
    this.clearWaitTimers(front);

    // claim() runs synchronously up to its own `await gen.readyPromise` —
    // by the time this call returns control here, `this.gen` already
    // points at the NEW generation object with its readyPromise assigned,
    // so every same-target waiter filtered below joins that exact promise,
    // not a fresh one.
    const promoted = this.claim(front.target, front.callId);
    promoted.then(front.resolve, front.reject);

    this.queue = this.queue.filter((e) => {
      if (!sameTarget(e.target, front.target)) return true;
      this.clearWaitTimers(e);
      const joined = this.claim(e.target, e.callId); // joins front's readyPromise — zero new PATCHes
      joined.then(e.resolve, e.reject); // resolves/rejects in lockstep with front
      return false;
    });
  }

  // ── Watchdog (§4: observability-only, never force-releases) ──────────────

  private armWatchdog(gen: Generation): void {
    gen.watchdogTimer = setTimeout(() => {
      // The generation may already be gone (released/replaced) by the time
      // this fires — nothing to report in that case.
      if (this.gen !== gen) return;
      const heldMs = Date.now() - gen.claimedAt;
      const holders = [...gen.holders];
      logger.error(
        `portLock: shared route to port ${gen.target.port} has been held continuously for ` +
          `${heldMs}ms, past maxHoldMs=${this.maxHoldMs}ms. Holders: ${holders.join(', ') || '(none)'}. ` +
          `This is an OBSERVABILITY-ONLY watchdog — the lock is NOT being force-released ` +
          `(forced release would risk misdirecting a still-live call to the wrong local port).`,
      );
      Telemetry.capture(TelemetryEvents.PORT_LOCK_MAX_HOLD_EXCEEDED, {
        port: gen.target.port,
        isHttpsLocal: Boolean(gen.target.isHttpsLocal),
        heldMs,
        maxHoldMs: this.maxHoldMs,
        holders,
      });
    }, this.maxHoldMs);
    // Never let this timer keep the process alive on its own.
    gen.watchdogTimer.unref?.();
  }

  private clearWatchdog(gen: Generation): void {
    if (gen.watchdogTimer) clearTimeout(gen.watchdogTimer);
  }

  // ── Queue bookkeeping ──────────────────────────────────────────────────────

  private startTicker(entry: QueueEntry): void {
    entry.tickTimer = setInterval(() => {
      if (!entry.onWaitProgress) return;
      const blockingPort = this.gen?.target.port;
      if (blockingPort === undefined) return; // shouldn't happen while genuinely queued
      const info: PortWaitInfo = {
        targetPort: entry.target.port,
        blockingPort,
        waitedMs: Date.now() - entry.enqueuedAt,
      };
      void Promise.resolve(entry.onWaitProgress(info)).catch((err) => {
        logger.warn(`portLock: onWaitProgress callback threw for port ${entry.target.port}: ${err}`);
      });
    }, this.waitTickMs);
    entry.tickTimer.unref?.();
  }

  /** Clears an entry's timeout/ticker timers and unregisters its abort
   *  listener. Called both when a queued entry is promoted (§5.4's
   *  dedicated test covers this) and when it's removed for any other
   *  reason (timeout, abort, cross-tunnel eviction). */
  private clearWaitTimers(entry: QueueEntry): void {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    if (entry.tickTimer) clearInterval(entry.tickTimer);
    if (entry.onAbort && entry.signal) entry.signal.removeEventListener('abort', entry.onAbort);
  }

  /** Removes `entry` from the queue if still present, clearing its timers.
   *  Returns whether it was actually found/removed (a call may race a
   *  timeout/abort against being promoted). */
  private removeFromQueue(entry: QueueEntry): boolean {
    const idx = this.queue.indexOf(entry);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    this.clearWaitTimers(entry);
    return true;
  }

  // ── Test/diagnostic helpers ────────────────────────────────────────────────

  /** Number of callers currently queued behind a different-port holder. */
  get queueLength(): number {
    return this.queue.length;
  }

  /** The port/isHttpsLocal the lock is currently holding a generation for,
   *  or null if nothing is currently claimed. */
  get currentTarget(): UpstreamTarget | null {
    return this.gen ? this.gen.target : null;
  }
}
