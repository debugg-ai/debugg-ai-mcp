/**
 * Tests for services/caddy/portLock.ts.
 *
 * See docs/local-tunnel-multiplexer-architecture-2026-07-31.md §2.4 (design)
 * and §5.4 (test list) — this file implements that list, including the
 * "three-caller promotion race" (§3.4/§5.4's own description: "the single
 * most important new lock test in this whole epic") and the cross-tunnel
 * stopTunnel-interaction test.
 *
 * `PortLock` has no module-level side-effecting dependencies worth swapping
 * out via `jest.unstable_mockModule` — its only imports are the plain
 * `logger`/`Telemetry` singletons (mutable object exports, safe to
 * `jest.spyOn` directly, same as `__tests__/utils/logger.test.ts` does) and
 * a type-only import of `caddyProxy.ts` (erased at compile time, no runtime
 * dependency). So this file uses plain static imports + `jest.spyOn`
 * throughout rather than the mock-module-then-dynamic-import incantation,
 * which is reserved for cases where a dependency's real behavior must be
 * replaced, not merely observed.
 */

import { jest } from '@jest/globals';
import {
  PortLock,
  PortRouteQueueTimeoutError,
  PortLockAbortedError,
  CaddyRepointError,
  type PortWaitInfo,
  type UpstreamTarget,
} from '../../services/caddy/portLock.js';
import { logger } from '../../utils/logger.js';
import { Telemetry, TelemetryEvents } from '../../utils/telemetry.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

type ApplyUpstreamFn = (t: UpstreamTarget) => Promise<void>;

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mockApply(): jest.Mock<ApplyUpstreamFn> {
  return jest.fn<ApplyUpstreamFn>(async () => {});
}

let errorSpy: jest.SpiedFunction<typeof logger.error>;
let warnSpy: jest.SpiedFunction<typeof logger.warn>;
let captureSpy: jest.SpiedFunction<typeof Telemetry.capture>;

beforeEach(() => {
  errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  captureSpy = jest.spyOn(Telemetry, 'capture').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Same-port vs different-port semantics ───────────────────────────────────

describe('same-port concurrency — zero contention', () => {
  test('two same-port callers both proceed without either waiting on the other, one applyUpstream call total', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);

    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });

    const start = Date.now();
    const handleB = await lock.acquire({ port: 3000 }, { callId: 'b' });
    const elapsedMs = Date.now() - start;

    expect(applyUpstream).toHaveBeenCalledTimes(1);
    expect(applyUpstream).toHaveBeenCalledWith({ port: 3000 });
    expect(elapsedMs).toBeLessThan(50);
    expect(lock.queueLength).toBe(0);

    handleA.release();
    handleB.release();
  });

  test('both same-port dispatches run fully concurrently; releasing one keeps the generation alive for the other', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);

    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });
    const handleB = await lock.acquire({ port: 3000 }, { callId: 'b' });

    handleA.release();
    // B is still an active holder of the generation.
    expect(lock.currentTarget).toEqual({ port: 3000 });

    handleB.release();
    expect(lock.currentTarget).toBeNull();
  });

  test('same port with flipped isHttpsLocal is a DIFFERENT generation identity, not a free join', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);

    const handleA = await lock.acquire({ port: 3000, isHttpsLocal: false }, { callId: 'a' });
    const bPromise = lock.acquire({ port: 3000, isHttpsLocal: true }, { callId: 'b' });
    await tick();
    expect(lock.queueLength).toBe(1);

    handleA.release();
    const handleB = await bPromise;

    expect(applyUpstream).toHaveBeenCalledTimes(2);
    expect(applyUpstream).toHaveBeenNthCalledWith(1, { port: 3000, isHttpsLocal: false });
    expect(applyUpstream).toHaveBeenNthCalledWith(2, { port: 3000, isHttpsLocal: true });

    handleB.release();
  });
});

describe('different-port concurrency — full-call serialization', () => {
  test('a different-port caller does not dispatch until the current holder releases', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);

    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });

    let bAcquired = false;
    const bPromise = lock.acquire({ port: 4000 }, { callId: 'b' }).then((h) => {
      bAcquired = true;
      return h;
    });

    await tick(20);
    expect(bAcquired).toBe(false);
    expect(lock.queueLength).toBe(1);
    expect(applyUpstream).toHaveBeenCalledTimes(1); // no repoint to 4000 yet

    handleA.release();
    const handleB = await bPromise;

    expect(bAcquired).toBe(true);
    expect(applyUpstream).toHaveBeenCalledTimes(2);
    expect(applyUpstream).toHaveBeenNthCalledWith(1, { port: 3000 });
    expect(applyUpstream).toHaveBeenNthCalledWith(2, { port: 4000 });

    handleB.release();
  });

  test('serialization holds for the WHOLE call, not just the repoint — releasing only after simulated dispatch work', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);

    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });

    const bPromise = lock.acquire({ port: 4000 }, { callId: 'b' });

    // Simulate A's dispatch continuing to run long after its own repoint
    // resolved — B must remain blocked throughout.
    await tick(30);
    expect(lock.queueLength).toBe(1);
    let bSettled = false;
    bPromise.then(() => { bSettled = true; });
    await tick(30);
    expect(bSettled).toBe(false);

    handleA.release();
    await bPromise;
    expect(bSettled).toBe(true);
  });

  test('acquire() never resolves before applyUpstream has actually settled (no window between "released" and "dispatch truly done")', async () => {
    const gate = deferred<void>();
    const applyUpstream = jest.fn<ApplyUpstreamFn>(() => gate.promise);
    const lock = new PortLock(applyUpstream);

    let resolved = false;
    const p = lock.acquire({ port: 3000 }, { callId: 'a' }).then((h) => {
      resolved = true;
      return h;
    });

    await tick(10);
    expect(resolved).toBe(false);

    gate.resolve();
    const handle = await p;
    expect(resolved).toBe(true);
    handle.release();
  });
});

// ── Crash / exception safety ────────────────────────────────────────────────

describe('crash and exception safety', () => {
  test('A throwing mid-dispatch still releases via its own finally; B is not deadlocked and Caddy ends up pointed only at B', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);

    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });

    await expect(
      (async () => {
        try {
          throw new Error('dispatch blew up');
        } finally {
          handleA.release();
        }
      })(),
    ).rejects.toThrow('dispatch blew up');

    expect(lock.currentTarget).toBeNull();

    const handleB = await lock.acquire({ port: 4000 }, { callId: 'b' });
    expect(applyUpstream).toHaveBeenCalledTimes(2);
    expect(lock.currentTarget).toEqual({ port: 4000 });

    handleB.release();
    expect(lock.currentTarget).toBeNull();
  });

  test('release() is a safe no-op (logged, not thrown) for an unmatched callId or a stale/already-released target', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);

    const handle = await lock.acquire({ port: 3000 }, { callId: 'a' });
    handle.release();

    expect(() => handle.release()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    expect(lock.currentTarget).toBeNull();
  });
});

// ── No starvation ────────────────────────────────────────────────────────────

describe('no starvation — FIFO ordering', () => {
  test('queued different-port callers are served in strict arrival order', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);

    const order: string[] = [];
    const handleA = await lock.acquire({ port: 1000 }, { callId: 'a' });

    const pB = lock.acquire({ port: 2000 }, { callId: 'b' }).then((h) => {
      order.push('b');
      return h;
    });
    await tick();
    const pC = lock.acquire({ port: 3000 }, { callId: 'c' }).then((h) => {
      order.push('c');
      return h;
    });
    await tick();
    const pD = lock.acquire({ port: 4000 }, { callId: 'd' }).then((h) => {
      order.push('d');
      return h;
    });
    await tick();

    expect(lock.queueLength).toBe(3);

    handleA.release();
    const handleB = await pB;
    handleB.release();
    const handleC = await pC;
    handleC.release();
    const handleD = await pD;
    handleD.release();

    expect(order).toEqual(['b', 'c', 'd']);
  });
});

// ── Abort propagation for queued-but-not-yet-running callers ────────────────

describe('abort propagation', () => {
  test('acquire() rejects immediately (no queueing at all) if the signal is already aborted', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);
    const controller = new AbortController();
    controller.abort();

    await expect(lock.acquire({ port: 3000 }, { callId: 'a', signal: controller.signal })).rejects.toThrow(
      PortLockAbortedError,
    );
    expect(applyUpstream).not.toHaveBeenCalled();
    expect(lock.queueLength).toBe(0);
  });

  test('a queued caller whose signal aborts mid-wait is dequeued cleanly with no dangling waiter', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);

    const handleA = await lock.acquire({ port: 1000 }, { callId: 'a' });
    const controller = new AbortController();
    const bPromise = lock.acquire({ port: 2000 }, { callId: 'b', signal: controller.signal });

    await tick();
    expect(lock.queueLength).toBe(1);

    controller.abort();
    await expect(bPromise).rejects.toThrow(PortLockAbortedError);
    expect(lock.queueLength).toBe(0);

    // Releasing A must not attempt to promote the aborted, already-removed
    // B — nothing left in the queue, applyUpstream was only ever called for A.
    handleA.release();
    expect(applyUpstream).toHaveBeenCalledTimes(1);
    expect(lock.currentTarget).toBeNull();
  });

  test('a promoted (already-running) call is unaffected by its signal aborting afterward', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);
    const controller = new AbortController();

    const handleA = await lock.acquire({ port: 1000 }, { callId: 'a' });
    const bPromise = lock.acquire({ port: 2000 }, { callId: 'b', signal: controller.signal });
    await tick();

    handleA.release();
    const handleB = await bPromise; // promoted — resolves normally

    // Aborting now must not retroactively reject an already-resolved handle.
    controller.abort();
    expect(handleB.port).toBe(2000);
    handleB.release();
  });

  test('queue timeout past maxWaitMs rejects with PortRouteQueueTimeoutError and cleans up', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);
    lock.maxWaitMs = 20;

    const handleA = await lock.acquire({ port: 1000 }, { callId: 'a' });
    const bPromise = lock.acquire({ port: 2000 }, { callId: 'b' });

    await expect(bPromise).rejects.toThrow(PortRouteQueueTimeoutError);
    expect(lock.queueLength).toBe(0);

    handleA.release();
    expect(applyUpstream).toHaveBeenCalledTimes(1);
  });
});

// ── Wait-signal UX (onWaitProgress) ─────────────────────────────────────────

describe('onWaitProgress ticker', () => {
  test('a queued different-port caller receives ticks with targetPort/blockingPort/waitedMs', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);
    lock.waitTickMs = 10;

    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });
    const ticks: PortWaitInfo[] = [];
    const bPromise = lock.acquire(
      { port: 4000 },
      {
        callId: 'b',
        onWaitProgress: async (info) => {
          ticks.push(info);
        },
      },
    );

    await tick(35);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]).toEqual(
      expect.objectContaining({ targetPort: 4000, blockingPort: 3000 }),
    );
    expect(ticks[0].waitedMs).toBeGreaterThanOrEqual(0);

    handleA.release();
    const handleB = await bPromise;
    handleB.release();
  });

  test('same-port joiners never receive onWaitProgress ticks — they are never queued', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);
    const onWaitProgress = jest.fn<(info: PortWaitInfo) => Promise<void>>(async () => {});

    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });
    const handleB = await lock.acquire({ port: 3000 }, { callId: 'b', onWaitProgress });

    await tick(20);
    expect(onWaitProgress).not.toHaveBeenCalled();

    handleA.release();
    handleB.release();
  });

  test('a throwing onWaitProgress callback is caught and logged, never breaks the lock', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);
    lock.waitTickMs = 10;

    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });
    const bPromise = lock.acquire(
      { port: 4000 },
      { callId: 'b', onWaitProgress: async () => { throw new Error('progress sink is down'); } },
    );

    await tick(30);
    expect(warnSpy).toHaveBeenCalled();

    handleA.release();
    const handleB = await bPromise;
    expect(handleB.port).toBe(4000);
    handleB.release();
  });
});

// ── Watchdog (§4: observability-only, NEVER force-releases) ────────────────

describe('maxHoldMs watchdog', () => {
  test('logs and telemeters once a generation has been held past maxHoldMs, without clearing it', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);
    lock.maxHoldMs = 15;

    const handle = await lock.acquire({ port: 1000 }, { callId: 'a' });
    await tick(50);

    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toMatch(/1000/);
    expect(captureSpy).toHaveBeenCalledWith(
      TelemetryEvents.PORT_LOCK_MAX_HOLD_EXCEEDED,
      expect.objectContaining({ port: 1000, holders: ['a'] }),
    );

    // Never force-released — the caller still holds it and must release explicitly.
    expect(lock.currentTarget).toEqual({ port: 1000 });

    handle.release();
    expect(lock.currentTarget).toBeNull();
  });

  test('the watchdog does not fire again for a generation that already released before the deadline', async () => {
    const applyUpstream = mockApply();
    const lock = new PortLock(applyUpstream);
    lock.maxHoldMs = 15;

    const handle = await lock.acquire({ port: 1000 }, { callId: 'a' });
    handle.release();

    await tick(50);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(captureSpy).not.toHaveBeenCalled();
  });
});

// ── The three-caller promotion race (§2.4/§3.4 — "the single most important
//    new lock test in this whole epic" per the architecture doc) ───────────

describe('three-caller promotion race', () => {
  test('resolving case: exactly one applyUpstream call for the promoted target; B and C both wait for that SAME call and cannot resolve before it settles, no matter how many microtask ticks elapse', async () => {
    const applyUpstream = jest.fn<ApplyUpstreamFn>();
    const gate = deferred<void>();

    applyUpstream.mockImplementationOnce(async () => {}); // A's repoint to 3000
    const lock = new PortLock(applyUpstream);
    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });

    applyUpstream.mockImplementationOnce(() => gate.promise); // the port-4000 generation's repoint

    const bPromise = lock.acquire({ port: 4000 }, { callId: 'b' });
    await tick();
    const cPromise = lock.acquire({ port: 4000 }, { callId: 'c' });
    await tick();

    let bResolved = false;
    let cResolved = false;
    bPromise.then(() => { bResolved = true; });
    cPromise.then(() => { cResolved = true; });

    // Release A — synchronously promotes B (creating the new generation and
    // firing its applyUpstream call) and, within that SAME synchronous
    // stretch, C joins the identical in-flight promise.
    handleA.release();

    // Drain a large number of microtasks/macrotasks. Under the pre-fix bug
    // this doc's §2.4 describes, a joiner resolved on "the next microtask"
    // with no await at all — so if the fix regressed, B and/or C would show
    // resolved:true well before this loop finishes, while `gate` is still
    // deliberately unsettled.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await tick(20);

    expect(applyUpstream).toHaveBeenCalledTimes(2); // A once, port-4000 generation ONCE (not twice for B+C)
    expect(bResolved).toBe(false);
    expect(cResolved).toBe(false);

    gate.resolve();
    const [handleB, handleC] = await Promise.all([bPromise, cPromise]);

    expect(bResolved).toBe(true);
    expect(cResolved).toBe(true);
    expect(applyUpstream).toHaveBeenCalledTimes(2); // still exactly 2 — resolving didn't trigger extra calls
    expect(handleB.port).toBe(4000);
    expect(handleC.port).toBe(4000);

    handleB.release();
    handleC.release();
  });

  test('rejecting case: B and C both reject with CaddyRepointError, gen ends up null, and the lock is not wedged for a subsequent caller', async () => {
    const applyUpstream = jest.fn<ApplyUpstreamFn>();
    const gate = deferred<void>();

    applyUpstream.mockImplementationOnce(async () => {}); // A
    const lock = new PortLock(applyUpstream);
    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });

    applyUpstream.mockImplementationOnce(() => gate.promise); // port-4000 generation — will reject
    const bPromise = lock.acquire({ port: 4000 }, { callId: 'b' });
    await tick();
    const cPromise = lock.acquire({ port: 4000 }, { callId: 'c' });
    await tick();

    handleA.release();
    await tick();

    const cause = new Error('caddy admin API returned 500');
    gate.reject(cause);

    await expect(bPromise).rejects.toThrow(CaddyRepointError);
    await expect(cPromise).rejects.toThrow(CaddyRepointError);
    await expect(bPromise).rejects.toThrow(/caddy admin API returned 500/);
    await expect(cPromise).rejects.toThrow(/caddy admin API returned 500/);

    expect(applyUpstream).toHaveBeenCalledTimes(2); // still only one attempt for the port-4000 generation
    expect(lock.currentTarget).toBeNull();
    expect(lock.queueLength).toBe(0);

    // Not wedged: a fresh caller proceeds normally afterward.
    applyUpstream.mockImplementationOnce(async () => {});
    const handleD = await lock.acquire({ port: 5000 }, { callId: 'd' });
    expect(applyUpstream).toHaveBeenCalledTimes(3);
    expect(handleD.port).toBe(5000);
    handleD.release();
  });
});

// ── Cross-tunnel stopTunnel/onPortChanged eviction interaction (§5.4) ──────

describe('cross-tunnel stopTunnel interaction with a queued waiter', () => {
  test('a waiter promoted against a since-evicted (stopped) Caddy instance fails cleanly and never wedges the lock', async () => {
    // Models §5.4's scenario precisely: a waiter (B) is queued for port 4000
    // behind a holder (A) on port 3000. Before B is ever promoted, the
    // session's onPortChanged fires (a Caddy crash-respawn) and
    // TunnelManager's stopTunnel() tears the session's Caddy instance down
    // — entirely at the TunnelManager/CaddyProxy layer, out of this file's
    // scope (§2.3's unconditional-removal contract for TunnelInfo lives
    // there). What THIS lock must guarantee, regardless of that layer's
    // behavior, is that a promoted claim whose applyUpstream call fails —
    // for ANY reason, including "the underlying admin API now refuses
    // connections because the process was stopped" — fails cleanly rather
    // than hanging, and leaves the lock immediately reusable.
    const applyUpstream = jest.fn<ApplyUpstreamFn>();
    applyUpstream.mockImplementationOnce(async () => {}); // A's real repoint to 3000
    const lock = new PortLock(applyUpstream);
    const handleA = await lock.acquire({ port: 3000 }, { callId: 'a' });

    const bPromise = lock.acquire({ port: 4000 }, { callId: 'b' });
    await tick();
    expect(lock.queueLength).toBe(1);

    // Simulate the eviction landing while B is still queued: by the time B
    // is promoted, setUpstream()/adminRequest() would surface a connection
    // refusal from the now-dead admin API.
    const econnrefused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:0'), { code: 'ECONNREFUSED' });
    applyUpstream.mockImplementationOnce(async () => {
      throw econnrefused;
    });

    handleA.release(); // triggers promotion -> the doomed applyUpstream({port:4000}) call

    await expect(bPromise).rejects.toThrow(CaddyRepointError);
    await expect(bPromise).rejects.toThrow(/ECONNREFUSED/);

    expect(lock.queueLength).toBe(0);
    expect(lock.currentTarget).toBeNull();

    // The next call — representing the next call against a freshly
    // recreated session tunnel/Caddy instance — proceeds completely
    // normally; nothing about B's failure lingers.
    applyUpstream.mockImplementationOnce(async () => {});
    const handleC = await lock.acquire({ port: 5000 }, { callId: 'c' });
    expect(applyUpstream).toHaveBeenCalledTimes(3);
    handleC.release();
  });
});
