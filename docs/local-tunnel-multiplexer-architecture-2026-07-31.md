# One Ngrok Tunnel Per Session via Local Caddy Multiplexer (2026-07-31)

**bd epic `debugg_ai_mcp-6cfv`** — subtasks `.2` (lock/repoint design), `.3` (Caddy service), `.4` (TunnelManager rewire), `.5` (migration/cutover). This document is the buildable design: four source passes merged, then adversarially reviewed, with every **blocking** review finding fixed inline (not just flagged) and every defer-able finding logged in §6. Citations are grounded in the real tree as of this pass — `services/ngrok/tunnelManager.ts`, `handlers/triggerCrawlHandler.ts`, `handlers/runTestSuiteHandler.ts`, `handlers/probePageHandler.ts` were read directly to verify claims the earlier synthesis pass had only inherited secondhand (see §2.2, §2.3, §4).

---

## 1. Overview

Today, `services/ngrok/tunnelManager.ts` opens one ngrok tunnel per distinct local port a session tests (`createTunnel()` around line 674, dialing `addr: localAddr` computed per-port at `tunnelManager.ts:687-701`). ngrok bills per tunnel/endpoint, so N ports tested in one session bills N tunnels. The owner wants this collapsed to one tunnel, period.

Prior art (Feb 2026, beads `lb8`/`p6y`/`brl`/`vp9`, reverted same day, no root-cause bead) tried to multiplex one tunnel across ports via **path-prefix routing**: `https://{tunnelId}.ngrok.debugg.ai/p/{port}/foo` → Caddy strips `/p/{port}` → `localhost:{port}/foo`. This breaks on **root-absolute URLs** (`/api/...`, `/_next/...` — the default output of every modern dev-server framework): the browser resolves a leading-`/` path against the *origin*, never re-sending the `/p/{port}` prefix, so Caddy has no route for the bare path and 404s. This is almost certainly why the Feb design shipped broken (`p6y`'s own description flagged the risk going in and never fixed it).

A wildcard-hostname workaround (`ngrok.connect({hostname: '*.ngrok.debugg.ai'})`) was live-tested this session against a real ngrok account and is **confirmed impossible** through this codebase's SDK/flow: `connect()` returns a false-positive success string, no endpoint is actually created server-side, and real requests hit `ERR_NGROK_3200` from ngrok's own edge. **Locked conclusion, not re-litigated: one ngrok tunnel = one concrete hostname, always.**

**Decided architecture:** one ngrok tunnel per **session** (defined precisely in §2.1 — not literally "per process," and in HTTP transport it also carries a deployment-topology precondition, see §2.1's affinity subsection and §4), hostname `{tunnelId}.ngrok.debugg.ai` (unchanged scheme, unchanged minting), permanently dialing a local Caddy instance's fixed loopback proxy port. Caddy holds **exactly one** dynamic upstream — plain 1:1 `reverse_proxy`, **zero path or host rewriting** — repointed via its local (unbilled, loopback-only) admin API immediately before each tool dispatch that needs a different local port than Caddy is currently pointed at.

This structurally avoids the Feb bug rather than patching it: there is no `/p/{port}` prefix, so there is no second port "in the way" for a root-absolute request to collide with. `/api/foo` resolves against the tunnel's own origin exactly as it does today, and lands on whichever local server Caddy currently has behind that fixed origin.

This introduces one new risk the Feb design never had to think about: two calls targeting **different** ports racing on Caddy's single route. This is solved with an in-memory, per-session lock: same-port calls proceed concurrently with zero contention (no repoint needed); different-port calls fully serialize for the **whole tool call** — repoint → dispatch → release — not just the repoint, because a call can hold the tunnel for minutes and a mid-flight repoint-away would silently misdirect a live browser session into the wrong app.

**Post-synthesis adversarial review found six blocking bugs/gaps in the mechanism itself** — two were races in the shown lock pseudocode (§2.4), one was an unshown dedup guard on tunnel creation (§2.3), one was an unaddressed HTTP-transport scaling assumption (§2.1), one was a silently-inherited proxy behavior never made explicit (§2.2), one was an unverified assumption about a sibling tool's execution model (§2.3). All six are fixed below with concrete mechanisms and new regression tests, not just acknowledged. Six further findings were judged survivable for a v1 with a documented caveat; they're in §6.

---

## 2. Component design

### 2.1 Session identity — the concept everything else is scoped to

**"Session" is not always "process."**

- **stdio transport** (`index.ts:293-301`): one `Server` per process, one `StdioServerTransport`, torn down on `SIGINT`/`SIGTERM`. `tunnelManager` is a module singleton. One process = one caller for its whole life. Session ⇔ process, exactly.
- **HTTP transport** (`httpServer.ts:95-151`, doc comment: *"Stateless (no session id)... scales behind a plain load balancer"*): the **process** is long-lived, but a fresh `Server`+`StreamableHTTPServerTransport` is built **per POST**, and caller identity is carried only via `AsyncLocalStorage` (`utils/requestContext.ts`) for the backend bearer token. Since `tunnelManager` is still a bare module singleton, **today every HTTP caller on one process already shares one `activeTunnels` map.** Under the old per-port model this was accidentally safe (different callers hitting different ports got isolated tunnels for free). Under a single-Caddy-route-per-something model, two different callers sharing **one route regardless of port** is not a cost bug, it's a **cross-tenant correctness bug** — caller B's remote browser could get routed into caller A's dev server.

**Decision:** session identity = a **session key**, not literally "the process." stdio has exactly one session key for its whole life, so "per process" remains true there as a special case. HTTP must derive a distinct key per caller:

```ts
// services/ngrok/tunnelManager.ts (or a small shared util)
import { currentApiKey } from '../../utils/requestContext.js';
import { createHash } from 'node:crypto';

function getSessionKey(): string {
  const apiKey = currentApiKey();
  if (!apiKey) {
    // See §6 (defer-able finding: no-API-key fallback) — this collapses onto
    // one shared key if it's ever reachable. Logged loudly so it surfaces in
    // practice rather than silently pooling callers.
    logger.error('getSessionKey(): no API key in request context — falling back to a shared key. ' +
      'This MUST NOT be reachable on an authenticated HTTP path; if it fires, tunnel isolation is broken.');
    return 'stdio';
  }
  return `http:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
}
```

`requestContext.ts` intentionally has no imports, so this is a safe dependency from any layer.

**Practical consequence:** the "N ports → 1 tunnel" win is scoped per session key. A single HTTP-mode process serving 5 distinct callers still opens 5 tunnels — that was **already necessary** for tenant isolation, not new waste. What's fixed is that *each* caller now pays for exactly one tunnel regardless of how many local ports *they personally* test — **subject to the affinity precondition below.**

#### HTTP multi-replica affinity — required deployment precondition (closes review finding: HTTP horizontal scaling)

Deriving a session key per caller fixes cross-tenant bleed only if every call sharing that key lands in the **same process** — `tunnelManager`, `sessionTunnels`, and every `PortLock` are in-process module state, with no cross-process coordination (that coordination is exactly what `tunnelRegistry.ts` used to attempt, and exactly what §4 retires as a source of the `lc62`/`zmc9` bug class). `httpServer.ts`'s own doc comment states the transport is designed to *"scale behind a plain load balancer"* — i.e., multiple replica processes are an intended deployment shape this design must account for, not dismiss.

**Decision: HTTP-mode deployments that want the "one tunnel per session" property MUST run session-affine routing at the load balancer** — a consistent-hash or sticky-header/sticky-cookie rule keyed on the same identity `getSessionKey()` derives (in practice, hash the `Authorization` bearer token, or a header carrying the precomputed session key), so every call from one caller lands on the same backend replica for that caller's whole session (bounded by the tunnel's own 55-minute idle timeout — not by anything the LB needs to track). This is a **deployment-topology requirement documented here and in `README.md`/rollout docs (§5.6)**, not a code change in this repo: `httpServer.ts` itself is unchanged, still builds a fresh `Server`/transport per POST; the affinity constraint lives at the infrastructure layer in front of it.

**What happens if that precondition is not met (the honest degrade path, not swept under the rug):** each replica runs an independent `tunnelManager` singleton, so a session whose calls round-robin across *R* replicas can mint up to *R* independent session tunnels — one per replica it happens to land on — each billed and each auto-shut-off independently by the existing 55-minute idle timer. This is **not** a live-session-hijack correctness bug: per `httpServer.ts:95-151`'s own "fresh `Server`+transport per POST" construction, a single tool call's entire browser interaction (`executeWorkflow` → `pollExecution`, and everything the shared lock in §2.4 protects) is fully contained within **one replica's one process** for that call's whole duration. Replica B never holds a handle into replica A's in-flight call, so it cannot repoint Caddy underneath a browser session replica A is still driving — there is no shared mutable state *across* replicas for it to race on, only *within* one. What degrades under missing affinity is purely the tunnel count, not correctness: the `fcbm`-class double-provisioning problem is **relocated** (not eliminated) from "registry file split across `$TMPDIR`" to "session key not pinned to a replica," at reduced severity — cost-only, bounded by replica count, self-healing via the existing idle timeout. This is the same failure shape §4 already accepts and justifies for "two independent stdio processes on one machine"; it is not a new class of problem, just a new place the same bounded-and-accepted tradeoff shows up. Stdio mode is entirely unaffected (one process for the tool's whole life, per §2.1's original framing) — this precondition is HTTP-transport-specific.

This means the earlier framing "the epic's economics are already satisfied at the per-session-key scale" (§4) holds **only when this affinity precondition is provided**. Without it, the design still strictly dominates today's per-port model (worst case is *R* tunnels — bounded by replica count — instead of one tunnel per port tested — unbounded), but it does not fully deliver "one tunnel per session" for a caller whose calls happen to land on different replicas. Treat the LB affinity rule as a go/no-go rollout item for any multi-replica HTTP deployment, tracked alongside the Caddy-binary precondition (§4, §6).

### 2.2 Caddy service — `services/caddy/caddyProxy.ts`

One `CaddyProxyManager` instance per session key (constructed fresh by `TunnelManager` at session-tunnel-creation time, not a single process-wide singleton — required by §2.1's HTTP finding). In stdio, exactly one instance is ever created.

**Public interface:**

```ts
export interface UpstreamTarget {
  port: number;
  /** Mirrors tunnelManager.ts:687's originalUrl.startsWith('https:') check. */
  isHttpsLocal?: boolean;
}

export interface CaddyProxy {
  /** Idempotent; concurrent callers await the same in-flight start.
   *  Returns the CURRENT localOrigin/localPort/adminPort — re-call after
   *  any suspected crash, since a respawn can land on a different port. */
  ensureStarted(): Promise<{ localOrigin: string; localPort: number; adminPort: number }>;

  /** Repoint the single route. Always calls ensureStarted() internally
   *  first. Idempotent no-op if target is unchanged from the last applied
   *  target (this is what makes same-port concurrent calls free). */
  setUpstream(target: UpstreamTarget): Promise<void>;

  /** Best-effort liveness probe. Never throws. */
  isHealthy(): Promise<boolean>;

  /** Idempotent: kills the child process (if any), removes its config file. */
  stop(): Promise<void>;

  /** Fires when a crash-triggered respawn lands on a DIFFERENT localPort
   *  than before (sticky-port reclaim failed, fresh port succeeded). The
   *  caller's existing ngrok tunnel is now dialing a dead port — nothing
   *  Caddy-internal can fix this; the owner MUST tear down and recreate
   *  the whole session tunnel. See §4 "CaddyPortReclaimError" and §6. */
  onPortChanged(cb: (newLocalOrigin: string) => void): void;
}

export class CaddyBinaryNotFoundError extends Error {}
export class CaddyStartupError extends Error {}
export class CaddyAdminApiError extends Error {}
export class CaddyPortReclaimError extends CaddyStartupError {}
```

**Lifecycle:**

- Binary resolution: `CADDY_BIN` env var → `caddyBinOverride` → bare `'caddy'` on `PATH`. `ENOENT` on spawn → `CaddyBinaryNotFoundError` with an actionable install message. **v1 does not auto-download a Caddy binary** — see §4's decision.
- Two loopback-only ports found via bind-`:0`-and-close (`findFreePort()`): the proxy listener (what ngrok dials) and the admin API. Both re-found per instance — never hardcoded, since **multiple instances can now coexist in one process** (HTTP mode, §2.1).
- Config built **eagerly at spawn**, not lazily on first `setUpstream` — one code path for every call including the first, PATCH-only against a known `@id`-tagged node so config-shape drift 400s loudly instead of silently building new structure. Placeholder upstream dials a closed port (`127.0.0.1:1`) so a stray request 502s cleanly from the first millisecond instead of exposing a raw connection-refused.
- Config file: `~/.debugg-ai/caddy/config-{pid}-{instanceId}.json` — PID alone collides once one process hosts multiple session keys (HTTP mode), so a short random `instanceId` suffix is added. Deleted in `stop()`; startup sweep removes orphaned files whose PID is dead.
- Both listeners bind `127.0.0.1` only — the admin API has no built-in auth, so this is a hard security requirement, not a convenience.
- Readiness: poll `GET /id/dbg-handler` every 100ms, capped at 5000ms, racing the child's `exit` event.
- `@id` **must be resent in every PATCH body**, not just the initial load — PATCH replaces the value at that address, so an omitted `@id` deletes the tag and the *next* PATCH 404s. This only manifests on the second call — flagged with an explicit code comment and a dedicated regression test (test plan §5.3, "LIFE-4").
- One PATCH atomically replaces both `dial` and `transport` — never two separate requests, so Caddy is never briefly holding a mismatched dial/transport pair.

**HTTP/Docker upstream matrix — ownership decision.** **Caddy owns it internally**, computing `inDocker` itself from `process.env.DOCKER_CONTAINER` (exactly matching how `tunnelManager.ts:688` reads it today — a process-global check, never a per-call parameter), taking only `isHttpsLocal` from the caller (the one fact Caddy cannot derive):

```ts
function resolveDialAddress(port: number, isHttpsLocal: boolean, inDocker: boolean): string {
  const dockerHost = 'host.docker.internal';
  if (isHttpsLocal) return inDocker ? `${dockerHost}:${port}` : `localhost:${port}`;   // NOT 127.0.0.1 — preserved verbatim
  return inDocker ? `${dockerHost}:${port}` : `127.0.0.1:${port}`;
}
```

The `localhost` (not `127.0.0.1`) asymmetry on the HTTPS/non-Docker branch is preserved **verbatim** from `tunnelManager.ts:698`, per explicit brief — flagged as its own future bead if it ever bites (IPv6 resolution racing a dev server bound only to `127.0.0.1`). `transport` when `isHttpsLocal`: `{ protocol: "http", tls: { insecure_skip_verify: true } }` — local self-signed certs, doesn't touch the public leg's real ngrok TLS.

#### Host header policy toward the upstream app (closes review finding: unspecified Host handling)

Verified against the real current code, not left implicit. `tunnelManager.ts`'s `connectOpts` (lines 722-726: `{ proto: 'http', addr: localAddr, hostname: tunnelDomain, authtoken }`) sets **no** `host_header` option — grepped repo-wide (`host_header`, `hostHeader`, `Host header`, `host-header`), no code path anywhere sets or rewrites `Host` today. Whatever Host value ngrok's agent forwards to `localAddr` by default is therefore already exactly what every local dev server sees today; this design's job is to **preserve that byte-for-byte** across the new second hop, not to newly define it.

Caddy's `reverse_proxy` has the same "preserve by default" behavior as the current ngrok leg: **left with no `header_up Host ...` directive, Caddy forwards the inbound Host header unchanged** to whatever `dial` target `setUpstream` currently points at — this is Caddy's documented default (unlike some proxies, it does not rewrite Host to match the dial address unless explicitly told to). Composing the two hops: ngrok still dials `addr: http://127.0.0.1:{caddyLocalPort}` (Caddy is "the app" from ngrok's point of view) and forwards whatever Host it forwards today — unchanged input, unchanged ngrok-side behavior. Caddy then forwards that identical Host value on to `127.0.0.1:{port}` on the second hop. **Net result: the local dev server receives the identical Host header value before and after this migration** — nothing in the new path introduces a rewrite that didn't exist before.

This is a **hold-the-line constraint, not a new mechanism** — the config builder must never emit a `header_up Host` line, called out with an explicit code comment (`// DO NOT add header_up Host — see docs/local-tunnel-multiplexer-architecture-2026-07-31.md §2.2; this would change what every local dev server sees vs. today`), since `header_up Host {upstream_hostport}` is one of the most common snippets in Caddy's own documentation and an easy "fix" for someone to paste in later without realizing it changes app-visible behavior. Because ngrok's own exact default Host-forwarding behavior is not independently re-verified here (it is *inherited*, not designed, and out of scope to re-derive), this is locked down with a regression test (§5.3): capture the literal Host header string a local test server receives through the full new ngrok→Caddy→app path and assert it is byte-identical to the header captured through today's direct ngrok→app path for the same request — a behavioral snapshot, not just a config-shape assertion.

**Sticky proxy port across crash-respawn.**

```ts
private lastProxyPort: number | null = null;

private async doStart(): Promise<void> {
  const bin = this.resolveCaddyBinary();
  let stickyAttemptFailed = false;
  const priorProxyPort = this.lastProxyPort;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const useSticky = attempt === 1 && priorProxyPort != null;
    const proxyPort = useSticky ? priorProxyPort! : await this.findFreePort();
    const adminPort = await this.findFreePort();
    const configPath = this.writeConfig(proxyPort, adminPort);
    const child = spawn(bin, ['run', '--config', configPath, '--adapter', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await this.waitForHealthy(adminPort, this.startTimeoutMs, child);
      this.child = child; this.proxyPort = proxyPort; this.adminPort = adminPort;
      this.started = true; this.lastProxyPort = proxyPort; this.lastAppliedTarget = null;
      this.installExitHandler(child);
      if (priorProxyPort != null && proxyPort !== priorProxyPort) {
        this.portChangedListeners.forEach(cb => cb(`http://127.0.0.1:${proxyPort}`));
      }
      return;
    } catch (err) {
      child.kill();
      if (useSticky) stickyAttemptFailed = true;
      if (attempt === 2) {
        throw stickyAttemptFailed
          ? new CaddyPortReclaimError(`Both proxy-port reclaim and fresh-port fallback failed: ${err}`)
          : new CaddyStartupError(String(err));
      }
    }
  }
}
```

`CaddyPortReclaimError` means "Caddy is fully down, both attempts failed." `onPortChanged` fires on the "succeeded but moved" case — the signal `TunnelManager` needs (§2.3).

**Restart policy:** lazy, bounded, next-call-triggered — no background watchdog, matching `ngrokAgentSession.ts`'s `onTerminated` philosophy. `adminRequest()` on a dead process attempts exactly one respawn-and-retry, then propagates uncaught — no loop.

### 2.3 TunnelManager — `services/ngrok/tunnelManager.ts`

**`TunnelInfo` — final shape:**

```ts
export interface TunnelInfo {
  tunnelId: string;
  sessionKey: string;                 // §2.1 — replaces `port` as the identity key
  tunnelUrl: string;                  // bare origin, unchanged meaning (bead zmc9)
  createdAt: number;
  lastAccessedAt: number;
  autoShutoffTimer?: NodeJS.Timeout;
  keyId?: string;
  revokeKey?: () => Promise<void>;
  caddy: CaddyProxy;                  // this session's own Caddy instance
  portLock: PortLock;                 // this session's own lock (§2.4) — bound to `caddy`
  // REMOVED: port, originalUrl, publicUrl, isOwned (every tunnel is owned by
  // construction now — see the per-session-key decision in §4)
}
```

#### Concurrent-first-call dedup (closes review finding: cold-start TOCTOU)

`ensureSessionTunnel()` replaces `createTunnel()`+`processPerPort()`. The read (`sessionTunnels.get`) and the eventual write (`sessionTunnels.set`) are separated by several `await` points (spawning Caddy, connecting ngrok) — without an explicit guard, two near-simultaneous first calls for the same fresh session key (exactly what an orchestrating agent produces: an initial navigate fired alongside an initial probe) would both observe a miss and each mint their own tunnel, silently defeating "one tunnel" at the single moment most likely to have concurrent calls. This is fixed with an explicit in-flight-creation map — the actual mechanism, mirroring (not merely citing) the existing `pendingTunnels` dedup pattern at `tunnelManager.ts:493-508`, re-keyed by `sessionKey`:

```ts
private sessionTunnels = new Map<string /*sessionKey*/, string /*tunnelId*/>();
private pendingSessionTunnels = new Map<string /*sessionKey*/, Promise<TunnelInfo>>();

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
    if (info) { this.touchTunnel(info.tunnelId); return info; }
  }

  // 2. A creation is already in flight for this session key — join it rather
  //    than starting a second one. This check-and-join is entirely
  //    synchronous relative to step 3 (no `await` between here and the
  //    `pendingSessionTunnels.set` below), so two calls arriving back-to-back
  //    on the event loop cannot both pass step 2 and each start a creation:
  //    whichever runs its synchronous prefix first wins the map slot, and the
  //    other necessarily observes it on its own synchronous prefix.
  const inFlight = this.pendingSessionTunnels.get(sessionKey);
  if (inFlight) return inFlight;

  // 3. First caller for this session key: claim the slot BEFORE any await.
  const creation = this.createSessionTunnel(sessionKey, authToken, specificTunnelId, keyId, revokeKey)
    .finally(() => { this.pendingSessionTunnels.delete(sessionKey); });
  this.pendingSessionTunnels.set(sessionKey, creation);
  return creation;
}

private async createSessionTunnel(
  sessionKey: string, authToken: string, specificTunnelId?: string,
  keyId?: string, revokeKey?: () => Promise<void>,
): Promise<TunnelInfo> {
  await this.ensureInitialized();

  const tunnelId = specificTunnelId ?? uuidv4();
  const tunnelDomain = `${tunnelId}.ngrok.debugg.ai`;         // UNCHANGED scheme, minted ONCE per session now
  const caddy = this.caddyFactory();                          // NEW instance per session key
  const { localOrigin } = await caddy.ensureStarted();

  logger.info(`Creating session tunnel (domain: ${tunnelDomain}, session: ${sessionKey})`);
  try {
    const tunnelUrl = await this.connectWithRetry(localOrigin, tunnelDomain, authToken); // byte-for-byte
                                                                                          // unchanged retry
                                                                                          // ladder, now dialing
                                                                                          // Caddy, not the app
    const now = Date.now();
    const portLock = new PortLock((t) => caddy.setUpstream(t));
    caddy.onPortChanged(() => {
      logger.error(`Caddy proxy port changed under session ${sessionKey} — evicting tunnel ${tunnelId}`);
      Telemetry.capture(TelemetryEvents.TUNNEL_EVICTED_PORT_CHANGED, { tunnelId, sessionKey });
      this.stopTunnel(tunnelId);   // never throws — see stopTunnel's unconditional-removal contract below
    });
    const info: TunnelInfo = { tunnelId, sessionKey, tunnelUrl, createdAt: now, lastAccessedAt: now,
                                keyId, revokeKey, caddy, portLock };
    this.activeTunnels.set(tunnelId, info);
    this.sessionTunnels.set(sessionKey, tunnelId);
    return info;
  } catch (error) {
    await caddy.stop().catch(() => {});   // never leak a Caddy process on connect failure
    throw error;
  }
}
```

`isHttpsLocal`/`inDocker`/`dockerHost` handling does **not** move into `createSessionTunnel` — ngrok's own dial target is now always `http://127.0.0.1:{caddyLocalPort}`, plain loopback HTTP, no HTTPS/Docker complexity on that leg at all (Caddy runs in the same host/container as the MCP server). That matrix moves entirely into Caddy (§2.2), invoked per-dispatch via `setUpstream`, not per-tunnel-creation. §3.5 walks the concurrent-first-call scenario this dedup guard exists for.

#### `markTunnelDead(tunnelId)` and `stopTunnel()` — unconditional state removal (closes review finding: onPortChanged cleanup ordering)

`markTunnelDead(tunnelId)` drops the `port` parameter — eviction is no longer port-scoped:
```ts
async markTunnelDead(tunnelId: string): Promise<void> {
  await this.stopTunnel(tunnelId);
}
```
`utils/tunnelDisposition.ts`'s `disposeUnhealthyTunnel` simplifies to call it with just `tunnelId`, dropping its `extractLocalhostPort` requirement.

`stopTunnel()`'s ordering is now an explicit, load-bearing contract, not an implementation detail: **map removal is unconditional and happens before any cleanup I/O**, so a downstream cleanup failure (ngrok revoke, `caddy.stop()`, key revoke) can never leave a live-looking-but-actually-dead `TunnelInfo` behind for the next call to find — the exact failure mode the `onPortChanged`-triggered eviction path exists to avoid re-creating:

```ts
async stopTunnel(tunnelId: string): Promise<void> {
  const info = this.activeTunnels.get(tunnelId);
  if (!info) return;   // already gone — idempotent, safe to call from onPortChanged more than once

  // Unconditional, synchronous, BEFORE any cleanup I/O. A partial failure
  // below can never leave stale-but-discoverable state — the next call for
  // this session key always sees a clean miss and rebuilds from scratch.
  this.activeTunnels.delete(tunnelId);
  if (this.sessionTunnels.get(info.sessionKey) === tunnelId) {
    this.sessionTunnels.delete(info.sessionKey);
  }
  if (info.autoShutoffTimer) clearTimeout(info.autoShutoffTimer);

  const results = await Promise.allSettled([
    this.disconnectNgrok(info.tunnelUrl),
    info.caddy.stop(),
    info.revokeKey ? info.revokeKey() : Promise.resolve(),
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      // Logged and telemetered, never rethrown and never blocks/reverts the
      // removal above — state is already gone by the time this runs.
      logger.warn(`stopTunnel(${tunnelId}) cleanup step ${i} failed (state already removed): ${r.reason}`);
      Telemetry.capture(TelemetryEvents.TUNNEL_TEARDOWN_PARTIAL_FAILURE, { tunnelId, step: i });
    }
  });
}
```

Because `stopTunnel` now never throws (failures are caught inside `Promise.allSettled`, not propagated), the `onPortChanged` handler in `createSessionTunnel` above needs no defensive `.catch()` of its own — there is nothing left for it to catch. A queued lock waiter that gets promoted against a Caddy instance mid-teardown will instead see its own `setUpstream`/`applyUpstream` call fail against a dead admin API, surfacing as a clean `CaddyRepointError` on that one call rather than corrupting shared state (see §6 for the residual, accepted narrowness of this window).

**`stopTunnel()`** additionally drops its entire `isOwned` branch (every tunnel is owned by construction now — §4's per-session-key decision retires cross-process borrowing).

**Retired outright** (per team policy — no deprecated aliases): `processUrl()`, `getTunnelForPort()`, `findTunnelByPort()`, `processPerPort()`, `borrowRegistryEntry()`, `adoptOrCreateTunnel()`, `reconcileWithLocalAgents()`'s cross-owner adoption, `isEntryUsable()`, `registryFreshnessTtlMs`. This is essentially every bug-history comment in the file's header (zmc9, lc62's borrow half, 3th, y7x6) — all lived in exactly this code, and all are dead once cross-process borrowing is retired (§4).

#### `trigger_crawl` is not a second exception — verified, not assumed (closes review finding: unverified execution model)

The original synthesis carved `run_test_suite` out of "hold the session lock for the whole call" because it is fire-and-forget: `handlers/runTestSuiteHandler.ts` calls `client.runTestSuite(suiteUuid, ...)` once (line 136) and returns (line 138) — no poll loop, confirmed by reading the file end-to-end (no `pollExecution` call anywhere in it). The review correctly flagged that this exact question was never asked of `trigger_crawl`, which shares the same "provision tunnel → dispatch → release" shape in the doc's prose.

Read directly against `handlers/triggerCrawlHandler.ts`: it is **not** fire-and-forget. Its own header comment (`triggerCrawlHandler.ts:6`) states the 4-step pattern *"find template → provision tunnel if localhost → execute → poll → result"* — shared with `check_app_in_browser`/`probe_page`, not with `run_test_suite`. Concretely, it calls `client.workflows!.executeWorkflow(...)` (line 265) and then `await client.workflows!.pollExecution(executionUuid, ...)` (line 277) **before** returning; the `finally` block that releases resources is at line 371. So `trigger_crawl` genuinely holds the connection open (via the poll loop) for the full duration real backend traffic can occur — holding the session lock for the whole call is correct and sufficient for it, exactly as originally planned for `check_app_in_browser`/`probe_page`. **`run_test_suite` remains the only handler needing the dedicated-tunnel carve-out below.**

**A named, deliberate exception: `run_test_suite` keeps a dedicated per-port tunnel, outside Caddy entirely.** `runTestSuiteHandler.ts` is fire-and-forget — the handler dispatches and returns immediately, with **no poll loop**, no bounded window the MCP process observes. All real tunnel traffic happens on the backend for a duration this process has zero visibility into, *after* any lock this handler held would already have released. Holding the shared session lock "for the whole call" gives this handler no protection at all — it would release the route back to contention seconds after triggering a suite that goes on to use that port for possibly many more minutes. So:

```ts
/** Used ONLY by runTestSuiteHandler.ts. Bypasses Caddy/PortLock entirely —
 *  dials ngrok straight at the app, exactly like today's per-port
 *  createTunnel(). Governed by the same idleTimeoutMs auto-shutoff as any
 *  other tunnel. This is a deliberate, scoped exception to "one tunnel per
 *  session" — not a smuggled-in legacy fallback — forced by run_test_suite's
 *  async execution model (no poll, no bounded window to hold a lock over). */
async acquireDedicatedTunnel(url: string, authToken: string, keyId?: string, revokeKey?: () => Promise<void>): Promise<{ url: string; tunnelId: string }>
```

Accounting note: a session that calls both `check_app_in_browser` (session tunnel) and `run_test_suite` (dedicated tunnel) pays for 2 tunnels, not 1, for that session. This is honest and bounded — flagged in §6, not hidden.

### 2.4 Lock/serialization — `services/caddy/portLock.ts` + `utils/tunnelContext.ts` hooks

The lock is **per-session** (per `TunnelInfo`), not a global singleton — a global lock would serialize calls from completely unrelated callers on totally different Caddy instances (per §2.1, one process can host N session keys in HTTP mode, each with its own Caddy instance). Constructed once per `TunnelInfo` in `createSessionTunnel` (§2.3). The lock's generation identity is `{port, isHttpsLocal}`, not `port` alone — a same-port-but-flipped-`isHttpsLocal` request needs a real repoint too, which `setUpstream`'s own idempotency check already distinguishes; the lock must agree with it.

#### Race fix: joiners must await the same in-flight repoint, not a synchronously-resolved handle (closes review finding: promotion race)

The original pseudocode had `promoteNextWaiter()` call `claim()` independently for the front waiter and for each same-target queued joiner. Tracing the execution order: `claim(front)` runs synchronously up to `await this.applyUpstream(target)` — meaning `this.gen` is assigned *before* the function suspends — then control returns synchronously to `promoteNextWaiter`, which immediately calls `claim(joiner)` for any same-target queued waiter. Inside that second call, `this.gen !== null`, so the "start a new generation" branch is skipped entirely — no `await` — and the joiner's promise resolves on the next microtask, **long before `front`'s real network `PATCH` to Caddy's admin API has completed, and even if that `PATCH` later fails.** This is a live "dispatch before repoint confirmed" race, directly contradicting the design's own invariant that `acquirePortRoute` only returns once the repoint is confirmed — that invariant held for the two-caller walkthroughs originally given, but broke the moment a third, same-target caller was queued behind a pending different-target claim. The same defect exists on the plain (non-promotion) join path in `acquire()` too: a brand-new caller for the *same* target as an in-flight-but-not-yet-confirmed claim would join synchronously and resolve immediately, without waiting for that claim's `PATCH` to land.

**Fix: every claimer of a generation — whether it's the one that creates it or a joiner — awaits the *same* `readyPromise` object (the actual `applyUpstream` call) before its handle resolves.** Bookkeeping (`refCount`/`holders`) is reserved synchronously, before any `await`, so a same-target racer arriving between generation-creation and the `await` still joins the one in-flight promise instead of triggering a second `PATCH`:

```ts
interface Generation {
  target: UpstreamTarget;
  refCount: number;
  holders: Set<string>;
  claimedAt: number;
  /** The in-flight (or already-settled) applyUpstream() call for `target`.
   *  EVERY claimer — first or joiner — awaits this exact promise object
   *  before its handle resolves. This is what makes the fix real: a joiner
   *  can never resolve ahead of the repoint it depends on. */
  readyPromise: Promise<void>;
}

export class PortLock {
  private gen: Generation | null = null;
  private queue: QueueEntry[] = [];

  public maxWaitMs = 20 * 60 * 1000;   // > check_app_in_browser's ~720s backend budget + retry overhead
  public maxHoldMs = 25 * 60 * 1000;   // observability watchdog ONLY — no force-release, see §4
  public waitTickMs = 3000;

  constructor(private readonly applyUpstream: (t: UpstreamTarget) => Promise<void>) {}

  async acquire(target: UpstreamTarget, opts: { callId: string; signal?: AbortSignal; onWaitProgress?: (i: PortWaitInfo) => Promise<void> }): Promise<PortRouteHandle> {
    if (opts.signal?.aborted) throw new PortLockAbortedError(opts.callId, target.port);
    if (this.gen === null || sameTarget(this.gen.target, target)) {
      return this.claim(target, opts.callId);   // synchronous decision, no await before the claim starts
    }
    return new Promise<PortRouteHandle>((resolve, reject) => {
      const entry: QueueEntry = { target, callId: opts.callId, enqueuedAt: Date.now(), resolve, reject, onWaitProgress: opts.onWaitProgress, signal: opts.signal };
      this.queue.push(entry);
      entry.timeoutTimer = setTimeout(() => {
        this.removeFromQueue(entry);
        reject(new PortRouteQueueTimeoutError(target.port, this.gen?.target.port, Date.now() - entry.enqueuedAt));
      }, this.maxWaitMs);
      entry.onAbort = () => {
        clearTimeout(entry.timeoutTimer);
        if (this.removeFromQueue(entry)) reject(new PortLockAbortedError(entry.callId, target.port));
      };
      opts.signal?.addEventListener('abort', entry.onAbort, { once: true });
      if (opts.onWaitProgress) this.startTicker(entry);
    });
  }

  /** Claims a slot on the current generation, creating one if needed. Every
   *  code path through here — new generation or joining an existing one —
   *  ends in `await gen.readyPromise` before returning a handle. */
  private async claim(target: UpstreamTarget, callId: string): Promise<PortRouteHandle> {
    let gen = this.gen;
    if (gen === null) {
      const readyPromise = this.applyUpstream(target);   // fired NOW, not awaited yet
      gen = { target, refCount: 0, holders: new Set(), claimedAt: Date.now(), readyPromise };
      this.gen = gen;                                     // <-- visible to same-tick joiners before we suspend
      gen.readyPromise.catch(() => { /* real handling happens per-claimer below */ });
    }
    // Reserve BEFORE awaiting: a joiner that calls claim() while gen.readyPromise
    // is still pending sees `this.gen` already set (from the branch above) and
    // skips straight to this reservation + the SAME await — never a second PATCH.
    gen.refCount++;
    gen.holders.add(callId);
    try {
      await gen.readyPromise;    // every claimer — first AND joiners — wait HERE
    } catch (err) {
      gen.holders.delete(callId);
      gen.refCount--;
      if (gen.refCount === 0 && this.gen === gen) {
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
    this.gen = null;
    this.promoteNextWaiter();
  }

  private promoteNextWaiter(): void {
    if (this.queue.length === 0) return;
    const front = this.queue.shift()!;
    this.clearWaitTimers(front);
    // claim() runs synchronously up to its own `await gen.readyPromise` — by
    // the time this call returns control here, `this.gen` already points at
    // the NEW generation object with its readyPromise assigned, so every
    // same-target waiter filtered below joins that exact promise, not a
    // fresh one.
    const promoted = this.claim(front.target, front.callId);
    promoted.then(front.resolve, front.reject);
    this.queue = this.queue.filter((e) => {
      if (!sameTarget(e.target, front.target)) return true;
      this.clearWaitTimers(e);
      const joined = this.claim(e.target, e.callId);   // joins front's readyPromise — zero new PATCHes
      joined.then(e.resolve, e.reject);                // resolves/rejects in lockstep with front
      return false;
    });
  }
  // startTicker / clearWaitTimers / removeFromQueue: bookkeeping. Explicitly
  // includes unregistering each entry's abort listener on promotion — see
  // §5.4's dedicated test for this (review finding: understated bookkeeping).
}

export class PortRouteQueueTimeoutError extends Error {}
export class PortLockAbortedError extends Error {}
export class CaddyRepointError extends Error {}
```

**Properties, re-checked against the fixed code:** same-port calls join for free in the sense that matters — **zero additional admin-API calls, ever** (`applyUpstream` is called exactly once per generation, never per-claimer) — and **zero added wait** once that generation's `PATCH` has already resolved (the common case: `testPageChangesHandler.ts`'s own `MAX_CONCURRENT=2` semaphore, lines 98-113, produces near-simultaneous same-port calls, but by the time the second one calls `acquire()` the first has typically already finished `acquirePortRoute` and moved into dispatch — see §3.3). A joiner that happens to arrive *while* the very first `PATCH` for its target is still in flight now correctly awaits that same in-flight promise rather than getting a premature handle (§3.4 walks this case explicitly — it's the scenario the original code silently got wrong). Different-port calls block in `acquire()` — not just during the repoint — because `release()` only fires from the caller's `finally`, once the whole tool call (which can run for minutes) is done. Failure never wedges the lock: no state survives a first-claimer failure (the `catch` block above nulls `gen` and promotes the next waiter), and every joiner of a failing generation independently catches the same rejection and cleans up its own slot (JS microtask ordering means each claimer's catch-block runs to completion before the next one starts, so the refCount arithmetic never races). FIFO by arrival; same-target waiters batched for free when promoted.

**`utils/tunnelContext.ts` hook points:**

```ts
export interface TunnelContext {
  originalUrl: string; isLocalhost: boolean; tunnelId?: string; targetUrl?: string;
  routeLock?: PortRouteHandle;   // NEW
}

export async function acquirePortRoute(
  ctx: TunnelContext,
  opts: { callId: string; signal?: AbortSignal; onWaitProgress?: (info: PortWaitInfo) => Promise<void> },
): Promise<TunnelContext> {
  if (!ctx.isLocalhost || !ctx.tunnelId) return ctx;
  const info = tunnelManager.getTunnelInfo(ctx.tunnelId);
  if (!info) throw new Error(`acquirePortRoute: no TunnelInfo for ${ctx.tunnelId}`);
  const port = extractLocalhostPort(ctx.originalUrl)!;
  const isHttpsLocal = ctx.originalUrl.startsWith('https:');
  const routeLock = await info.portLock.acquire({ port, isHttpsLocal }, opts);
  return { ...ctx, routeLock };
}

export function releasePortRoute(ctx: TunnelContext): void {
  ctx.routeLock?.release();
}
```

**Per-handler wiring:** insert `ctx = await acquirePortRoute(ctx, {...})` immediately after `ensureTunnel`/`findExistingTunnel` and **before** `probeTunnelHealth` (probing before the repoint is confirmed would probe whatever port happened to be active a moment ago); add one line, `releasePortRoute(ctx)`, to each handler's **existing** `finally` block (`testPageChangesHandler.ts:978`, `probePageHandler.ts:400`, `triggerCrawlHandler.ts:371` — confirmed a real `} finally {` at that line) — zero new call sites, every existing early-return path is covered automatically. `run_test_suite` gets **no** lock integration at all (§2.3's exemption).

`findExistingTunnel`/`ensureTunnel` themselves keep their current signatures and call sites — internally they now call `tunnelManager.ensureSessionTunnel(...)` instead of the old `processUrl`/`getTunnelForPort`, and compute `ctx.targetUrl` via the unchanged `retargetTunnelUrl(tunnelInfo.tunnelUrl, ctx.originalUrl)`.

---

## 3. End-to-end sequences

### 3.1 First localhost call of a session (e.g. `check_app_in_browser` against `http://localhost:3000`)

1. `probeLocalPort(3000)` — cheap TCP check, unchanged, doesn't touch shared state.
2. `ensureTunnel(ctx, tunnelKey, tunnelId)` → `tunnelManager.ensureSessionTunnel(sessionKey, authToken, ...)`. No entry in `sessionTunnels` or `pendingSessionTunnels` for this `sessionKey` → claims the pending slot, mints `tunnelId = uuidv4()`, constructs a **new** `CaddyProxyManager` via `caddyFactory()`, calls `caddy.ensureStarted()` (spawns `caddy run` with the placeholder-upstream config, waits for `GET /id/dbg-handler` to return 200, ≤5s). Then `ngrok.connect({ addr: 'http://127.0.0.1:{caddyLocalPort}', hostname: '{tunnelId}.ngrok.debugg.ai', authtoken })` — the existing 3-attempt retry ladder runs unchanged, now dialing a process we spawned and control. `TunnelInfo` (with a fresh `PortLock` bound to this `caddy`) is stored in `activeTunnels` and `sessionTunnels`; the pending-slot entry is removed. `ctx.tunnelId`/`ctx.targetUrl` set via `retargetTunnelUrl`.
3. `acquirePortRoute(ctx, {callId, signal})` → `info.portLock.acquire({port: 3000, isHttpsLocal: false}, ...)`. `gen === null` → `claim()` creates a new generation, kicks off `applyUpstream({port:3000})` (a real `PATCH /id/dbg-handler` with `{dial: '127.0.0.1:3000'}`, since `lastAppliedTarget` is `null` — first call ever), assigns `this.gen` synchronously, reserves the slot, then `await`s `gen.readyPromise`. Resolves. `ctx.routeLock` set.
4. `probeTunnelHealth(ctx.targetUrl)` — now safe, Caddy is confirmed pointed at 3000 (the `PATCH` is what `readyPromise` awaited).
5. Template/project resolution, `executeWorkflow`, `pollExecution` — unchanged. Requests to `https://{tunnelId}.ngrok.debugg.ai/anything` (including root-absolute `/api/...` calls the target app itself makes) land on ngrok's edge, forward to Caddy's proxy port with the Host header untouched at every hop (§2.2), Caddy forwards to `127.0.0.1:3000` — no path rewriting anywhere, so the absolute-URL bug class doesn't exist here.
6. `finally`: `releasePortRoute(ctx)` → `gen.refCount` drops to 0 → `gen = null`, queue empty → nothing to promote.

### 3.2 Subsequent call in the same session, **different** port (e.g. `probe_page` against `localhost:4000`, arriving while step 5 above is still mid-poll)

1. `ensureSessionTunnel` — `sessionTunnels.get(sessionKey)` hits, returns the **existing** `TunnelInfo` unchanged (same `tunnelId`, same hostname, no new ngrok connect, `touchTunnel` refreshes the idle timer).
2. `acquirePortRoute` → `info.portLock.acquire({port: 4000, ...}, ...)`. `gen !== null` and `gen.target.port === 3000 !== 4000` → **not** a same-target join → pushed onto `queue`, a `maxWaitMs` (20 min) timer armed, an abort listener wired to this call's own `signal`. If the caller passed `onWaitProgress`, a 3s ticker surfaces `{ progress: <pinned>, message: "Waiting for shared tunnel — port 3000 is in use..." }` through the existing progress-notification pipe (`index.ts:83-107`) — silent server-side-logged-only if the client never opted into a `progressToken`.
3. This call is **fully blocked** — no repoint, no dispatch — until step 3.1's call 6 fires `releasePortRoute`, which sets `gen = null` and calls `promoteNextWaiter()`. That dequeues this call's entry, calls `claim({port:4000,...}, callId)`: since `this.gen` is `null` at this point, this creates a **new** generation and kicks off a genuine `applyUpstream({port:4000})` (`lastAppliedTarget` was `{dial:'127.0.0.1:3000',...}` so this is a real change), then awaits that promise.
4. Only **after** that `PATCH` is confirmed (the `await gen.readyPromise` inside `claim()` resolves) does `acquirePortRoute` return — `ctx.targetUrl` is safe to hand to `probeTunnelHealth`/the backend from this instant, not one tick before.
5. Dispatch proceeds exactly as in 3.1's steps 4-5, now against port 4000.
6. `finally`: release, `gen = null`, queue empty (assuming no third caller arrived).

No window exists where Caddy is pointed at 4000 while call A (still polling against 3000) could receive traffic against the wrong port — call A's `release()` is the only thing that lets call B's `claim()` even begin.

### 3.3 Subsequent call, **same** port as one already in flight (e.g. two concurrent `check_app_in_browser` calls both against `localhost:3000`, within `testPageChangesHandler.ts`'s own `MAX_CONCURRENT=2` slot)

1. Both calls reach `ensureSessionTunnel` — both hit the existing `TunnelInfo` (no new tunnel).
2. Call A's `acquirePortRoute` runs first, `gen === null` → `claim()` creates the generation, kicks off the real `PATCH` to 3000, awaits it, resolves — by construction this fully completes (including the network round-trip) before A's handler moves on to `probeTunnelHealth`/dispatch.
3. Call B's `acquirePortRoute` runs (possibly milliseconds later, once A is already in dispatch — i.e., **after** A's `PATCH` has already resolved): `gen !== null`, `sameTarget(gen.target, {port:3000})` is **true** → `claim()` takes the join branch, reserves a slot, and `await`s `gen.readyPromise` — which is already-settled, so this resolves on the very next microtask. **Zero admin-API calls, no meaningfully observable wait.**
4. Both dispatches proceed fully concurrently against the same Caddy upstream — correct, since they're hitting the same local app anyway.
5. Whichever of A/B finishes first releases: `refCount` → 1, `gen` stays alive (still held by the other). The second release drops `refCount` to 0 and clears `gen`.

### 3.4 The fixed race: a different-port holder with two same-target queued joiners, one arriving while the promoted claim's repoint is still in flight

This is the scenario the pre-fix pseudocode got wrong (review finding, §2.4). Three calls, one session:

1. Call A holds `gen = {port: 3000}` (mid-dispatch, long-running).
2. Call B (`port: 4000`) queues behind A — per §3.2.
3. Call C (`port: 4000`, arrives shortly after B, before A releases) — `gen.target.port === 3000 !== 4000` → also queues behind A, same-target as B.
4. A finishes, `release()` fires, `gen = null`, `promoteNextWaiter()` runs: dequeues B (front), calls `claim({port:4000}, B.callId)` — synchronously creates a new generation, **kicks off `applyUpstream({port:4000})` but does not await it yet inside this synchronous stretch**, assigns `this.gen`, reserves B's slot, then suspends at `await gen.readyPromise`. Control returns synchronously to `promoteNextWaiter`.
5. Still inside the same synchronous call to `promoteNextWaiter`, the queue filter reaches C: `sameTarget(C.target, B.target)` is true → `claim({port:4000}, C.callId)` runs. `this.gen` is **already** the generation B's claim just created (step 4), so this call skips the "create a new generation" branch, reserves C's slot, and suspends at `await gen.readyPromise` — **the exact same promise object B is awaiting**, still in flight from step 4.
6. The real `PATCH` for port 4000 resolves. **Both** B's and C's `await gen.readyPromise` resume (same microtask queue, same settled promise) and **both** now return handles — after, not before, the repoint is confirmed. This is the fix: under the original code, step 5 would have found `gen !== null`, skipped straight to `refCount++`/return with **no `await` at all**, handing C a valid-looking handle while the port-4000 `PATCH` from step 4 was still in flight (or, worse, after it had already failed).
7. If the `PATCH` in step 4 instead **fails**: both B's and C's `await` reject. Each independently runs its own `catch` block (JS microtask semantics: one claimer's catch runs to completion before the next starts), decrementing `refCount`/removing its own holder; the second one to run observes `refCount === 0` and nulls `gen`, promoting whatever's queued behind. Neither B nor C is left holding a phantom handle into a generation that never actually got applied.

### 3.5 Two near-simultaneous first calls for a brand-new session key (the cold-start dedup guard, §2.3)

An orchestrating agent fires an initial `check_app_in_browser` and, without waiting, an initial `probe_page` — both against the same fresh session (no tunnel exists yet for this `sessionKey`).

1. Call A reaches `ensureSessionTunnel(sessionKey, ...)`: `sessionTunnels.get` misses, `pendingSessionTunnels.get` misses. In the same synchronous stretch (no `await` yet), A calls `createSessionTunnel(...)` (returns a pending `Promise` immediately — its own internal `await this.ensureInitialized()` suspends it, but that suspension happens *inside* the call, after control has already returned the `Promise` object to `ensureSessionTunnel`), chains `.finally(...)`, and does `pendingSessionTunnels.set(sessionKey, creation)` — all synchronous, no interleaving possible with another call in between.
2. Call B reaches `ensureSessionTunnel(sessionKey, ...)` (whether truly concurrent-in-the-event-loop or just arriving microseconds later): `sessionTunnels.get` still misses (A hasn't finished), but `pendingSessionTunnels.get(sessionKey)` now **hits** A's in-flight promise → B returns it directly, joining A's creation rather than starting a second one.
3. A's creation completes: one Caddy instance spawned, one `ngrok.connect()` call made, `sessionTunnels.set(sessionKey, tunnelId)`, `pendingSessionTunnels.delete(sessionKey)` (via the `finally`). Both A and B resolve to the **same** `TunnelInfo` object.
4. A and B then proceed to `acquirePortRoute` independently, per §3.1/§3.3 depending on whether they target the same or different ports — but there is only ever one tunnel, satisfying the epic's core requirement even at the highest-concurrency moment of a session's life.

---

## 4. Decisions — every cross-cutting question, one answer

**Same-machine multi-process / multi-session sharing.** No sharing, ever, at any granularity. Each **session key** (§2.1) gets its own Caddy instance and its own ngrok tunnel. Justification: (1) the epic's economics are already satisfied at the per-session-key scale; (2) real cross-process sharing needs a genuine cross-process mutex with liveness/steal-on-crash semantics nothing in this codebase has today, reintroducing exactly the bug class (`lc62`, `zmc9`) this epic exists to eliminate, now for a cross-tenant-**correctness**-critical resource instead of a cost-only one; (3) it would let one caller's slow call block an unrelated caller for minutes with zero diagnostic surface. Bounded worst case: a developer with 2 open editors gets 2 tunnels, each auto-shutting off independently.

**HTTP multi-replica affinity — new decision, closes review finding.** HTTP-transport deployments that want the "one tunnel per session" guarantee **require session-affine load-balancer routing** keyed on the same identity `getSessionKey()` derives (§2.1). Without it, the design degrades to bounded, cost-only double-provisioning (up to *R* tunnels for *R* replicas a session's calls land on) — never a live-session correctness bug, because a single tool call's entire browser interaction is confined to one replica's one process by `httpServer.ts`'s own per-POST construction. This is a documented deployment precondition (rollout doc, §5.6), not a code change.

**Wait-signal UX.** Reuse the existing progress-notification pipe verbatim (already used for exactly this "phase pinned, message changing" pattern at `testPageChangesHandler.ts:474-480`). Queued different-port calls get `{progress: <pinned>, message: "Waiting for shared tunnel — port N is in use..."}` on a 3s ticker; same-port joiners never see this (admitted instantly, or after the one in-flight `PATCH` resolves — §2.4). No `progressToken` → silent client-side (an MCP protocol limitation, not fixable here) but always `logger.info`'d server-side. Bounded, not infinite: `maxWaitMs = 20 min`, comfortably above `check_app_in_browser`'s own ~720s worst-case budget plus retry overhead, rejecting with a structured `PortRouteQueueTimeoutError` rather than a silent hang.

**Timeout/recovery for a stuck or dead holder.** **Decided: no forced release, ever.** Force-releasing while a legitimately slow call is *still actually using* the port is precisely the traffic-misdirection failure this whole architecture exists to prevent — it directly contradicts the requirement that different-port calls hold the lock for the *whole* call specifically so nobody can repoint away mid-flight. `maxHoldMs = 25 min` is an **observability-only watchdog** — logs `logger.error` + `Telemetry.capture` with the offending `callId` if a generation has been held continuously past that ceiling, but never clears `gen`. Process death needs no timeout/reaping at all: the lock is in-memory only, so a dead process takes its `gen` and every queued `Promise` down with it.

**HTTPS/Docker upstream handling.** Caddy owns the full `isHttpsLocal`/`inDocker`/`dockerHost` resolution internally (§2.2), reading `inDocker` from its own `process.env.DOCKER_CONTAINER` check exactly as `tunnelManager.ts:688` does today. Callers pass only `{port, isHttpsLocal}`. ngrok's own dial target is always plain loopback HTTP to Caddy.

**Host header policy.** Caddy adds no `header_up Host` directive; combined with ngrok's own unmodified default forwarding (verified: no `host_header` option set anywhere in `tunnelManager.ts`'s `connectOpts`), the local app receives an identical Host header before and after this migration. See §2.2 for the full trace and the required regression test.

**`trigger_crawl` execution model.** Verified by reading `triggerCrawlHandler.ts` directly: it polls (`pollExecution` at line 277) exactly like `check_app_in_browser`/`probe_page`, and is not a second fire-and-forget exception. Only `run_test_suite` gets the dedicated-tunnel carve-out. See §2.3.

**Interface-shape mismatches.** One `CaddyProxy` interface serves as both the handle TunnelManager holds and the controller the lock calls (`setUpstream`); the lock is per-`TunnelInfo`, not a global singleton.

**Caddy binary distribution.** **v1 requires `caddy` discoverable on `PATH` or via `CADDY_BIN`, fails fast with an actionable `CaddyBinaryNotFoundError`** (install instructions for brew/apt/caddyserver.com). No postinstall auto-downloader in v1 — flagged as the single biggest rollout risk (§6).

**`probe_page` multi-port batches.** Group `input.targets` by port; single-port batches are unchanged (one repoint, one backend execution); multi-port batches run one `acquirePortRoute → executeWorkflow(subset) → poll → releasePortRoute` cycle per port group, sequentially, merging per-target results into one `ProbePageResult[]` response. Rejected alternative: hard-reject cross-port batches. Decomposition is graceful degradation (slower, N sequential backend round-trips) rather than a hard failure for a batch shape that worked yesterday.

**`sanitizeResponseUrls` cross-attribution.** Confirmed real and newly introduced by hostname-sharing: `probePageHandler.ts:354-359`'s per-target sanitize loop rewrites *any* remaining tunnel-hostname match in the *whole accumulated payload* on each pass — safe today only because every target has a distinct hostname. Once all targets share one session hostname, whichever `targetContexts[i]` sanitizes first claims every remaining occurrence. **Required fix, part of this cutover:** scope each sanitize call to `results[i]`'s own subtree, keyed by `targetContexts[i]`.

**`run_test_suite`'s missing sanitize call.** Currently safe only by accident of return-type narrowing. **Decided: add a defensive `sanitizeResponseUrls` call to this handler as part of this epic's cleanup pass.**

**Registry role and keying.** The registry stops being load-bearing for correctness and becomes **write-mostly observability**, keyed by `tunnelId` (not PID — PID alone can't hold multiple rows for multiple session keys sharing one HTTP-mode process):

```ts
export interface RegistryEntry {
  tunnelId: string; sessionKey: string;
  publicUrl: string; tunnelUrl: string;      // == each other now, path-baking is gone
  caddyAdminPort: number;
  ownerPid: number; lastAccessedAt: number;
}
```
`prune()` simplifies to a pure `isPidAlive` liveness filter — `staleAfterMs` is dropped entirely (it existed solely to protect borrow decisions; nothing borrows). Deleted outright: `isEntryUsable()`, `registryFreshnessTtlMs`, `adoptOrCreateTunnel()`, `borrowRegistryEntry()`, `reconcileWithLocalAgents()`'s cross-owner adoption, and `tunnelFaultInjection.ts`'s `inspector-adopt:<port>` fault mode.

---

## 5. Migration plan and test plan

### 5.1 Delete / keep / new — `services/ngrok/tunnelManager.ts`

| Action | What | Why |
|---|---|---|
| DELETE | `processPerPort()`, `findTunnelByPort()`, `getTunnelForPort()`'s port-liveness eviction, `borrowRegistryEntry()`, `adoptOrCreateTunnel()`/`reconcileWithLocalAgents()`'s adoption logic, all `registry[String(port)]` reads/writes, per-call-site `tunnelDomain` minting | The entire per-port routing mechanism and everything that existed only to make cross-process port-keyed borrowing safe |
| KEEP unchanged | `createTunnel()`'s connect-retry ladder, fault injection, agent pre-warm; `ensureAgentSession()`; `stopAllTunnels()`/SIGINT wiring; `idleTimeoutMs`/`resetTunnelTimer`'s core mechanism (minus its cross-process "another process touched it" branch) | Orthogonal to per-port-vs-per-session routing |
| MOVE | `isHttpsLocal`/`inDocker`/`dockerHost` matrix (`tunnelManager.ts:687-701`) | Into `caddyProxy.setUpstream()` (§2.2) — from "how ngrok dials the app" to "how Caddy dials the app," from once-per-port-at-creation to once-per-dispatch |
| NEW | `ensureSessionTunnel()`/`createSessionTunnel()`, `sessionTunnels`+`pendingSessionTunnels` maps, `PortLock` per `TunnelInfo`, `caddyFactory`, `acquireDedicatedTunnel()` (run_test_suite exception), `onPortChanged` eviction wiring with unconditional state removal | §2.3/§2.4 |

### 5.2 Existing tests that must change or be deleted

- **`__tests__/services/tunnelManager.concurrent.test.ts:72-79`** (`'calls for different ports each create their own tunnel'`) — this is the exact inverse of the new contract. Rewrite to assert **one** `createTunnel`/`ensureSessionTunnel` call total for two different-port calls in one session, serialized through the lock and Caddy repointed between them.
- **`__tests__/services/tunnelRegistry.test.ts`** — path-resolution/legacy-merge tests survive; port-as-key structure tests rewritten to the `tunnelId`-keyed shape (§4).
- **`__tests__/services/tunnelManager.test.ts`** — `'cross-process tunnel sharing'` (line 341) rewritten to assert each session key provisions its own, never borrows; `'processUrl'`/`'getTunnelForPort'` describe blocks rewritten around `ensureSessionTunnel`.
- **`__tests__/utils/tunnelContext.test.ts`** — `findExistingTunnel`'s "port → existing tunnel" lookup changes shape. New coverage for `acquirePortRoute`/`releasePortRoute`.
- **`__tests__/utils/tunnelDisposition.test.ts`** — `disposeUnhealthyTunnel`/`markTunnelDead` lose the `port` parameter.
- **`__tests__/handlers/probePageHandler.test.ts`** — currently has zero multi-port-batch coverage.
- `tunnelManager.agentReadiness.test.ts`, `tunnelFaultInjection.test.ts` — orthogonal, survive unchanged (minus the retired `inspector-adopt:<port>` fault mode).

### 5.3 New tests — Caddy service (`services/caddy/caddyProxy.ts`)

Pure logic: `resolveDialAddress()` all 4 combinations incl. the `localhost`-vs-`127.0.0.1` asymmetry as a regression guard; config builder produces valid JSON bound to `127.0.0.1` only with the `@id`-tagged handler node and **no `header_up Host` directive present anywhere in the generated config** (new — closes the Host-header finding); `findFreePort()` returns distinct ports on sequential calls; **`setUpstream` PATCH body always includes `@id`** (the resend trap — "LIFE-4", manifests only on the 2nd call); idempotency (unchanged target ⇒ zero admin calls; same port + flipped `isHttpsLocal` ⇒ new PATCH, not masked by a port-only comparison).

**Host header regression test (new, closes review finding):** a local test server that echoes back the `Host` header it received. One request through today's direct-ngrok-to-app path (control) and one through the full new ngrok→Caddy→app path (subject) for the same target port; assert the two captured Host strings are byte-identical. This is a real behavioral snapshot, not a config-shape assertion — it is the thing that would catch a Caddy version upgrade silently changing the default, or a future `header_up Host` addition slipping past review.

Lifecycle (mocked spawn/http): `ensureStarted()` spawns exactly once for N concurrent callers; resolves only after the health probe returns 200; rejects `CaddyBinaryNotFoundError` on `ENOENT`; retries once with fresh ports after an early crash, succeeds on attempt 2; throws `CaddyStartupError` after both attempts crash; respawn reuses the sticky `proxyPort`; respawn where the sticky port can't be rebound but a fresh port succeeds fires `onPortChanged`, does NOT throw; respawn where **both** attempts fail throws `CaddyPortReclaimError` specifically; `setUpstream` throws `CaddyAdminApiError` (no respawn) when the process is alive but the admin API 4xx/5xxs; `setUpstream` triggers exactly one respawn+retry when the process is confirmed dead, bounded; `stop()` idempotent, kills the child, removes the config file, safe as a no-op if never started.

Docker+HTTPS matrix (assert exact PATCH body): all 4 combinations of `{isHttpsLocal, inDocker}` produce the exact `dial`/`transport` shape from §2.2, including the `localhost`-not-`127.0.0.1` parity check.

Integration (gated on a real `caddy` binary, self-skipped in default `npm test`): real `caddy run` against the generated config actually accepts `PATCH /id/dbg-handler` as described; a trivial local HTTP server behind `setUpstream()`, a real request through the proxy port, body **and Host header** round-trip. Real `SIGKILL` mid-session detected via the `exit` handler, next `setUpstream()` self-heals via a real respawn including real sticky-port reclaim.

**The regression test for the Feb root cause, must exist before ship:** a local server serving a page whose JS does `fetch('/api/foo')` (root-absolute, the framework default), routed through Caddy — assert the request reaches the local server and is **not** a 404 from Caddy/ngrok.

### 5.4 New tests — lock (`services/caddy/portLock.ts`)

Same-port concurrency is not serialized (both start before either finishes, no false serialization tax). Different-port concurrency **is** serialized for the whole call, not just the repoint. No window exists where the lock is released before dispatch truly completes. Crash/exception safety: A throws mid-dispatch, lock still releases, B doesn't deadlock, Caddy isn't left pointed at a stale/unowned port. No starvation. Abort propagation: a queued (not-yet-running) call whose `context.signal` fires is dequeued cleanly, its abort listener unregistered, no dangling waiter. Watchdog fires `logger.error`+telemetry past `maxHoldMs` **without** clearing `gen`.

**Three-caller promotion race (new, closes review finding — the single most important new lock test):** one different-port holder (A, on port 3000, held via a controllable never-resolving dispatch promise) plus two same-target queued waiters (B and C, both port 4000). Make `applyUpstream` for port 4000 a controllable, manually-resolved promise. Release A; assert `promoteNextWaiter` fires exactly one `applyUpstream({port:4000})` call (not two — this is the "zero duplicate PATCHes" assertion); assert **neither** B's nor C's `acquire()` promise has resolved while that `applyUpstream` promise is still pending, no matter how many microtask ticks elapse; resolve `applyUpstream`; assert both B and C resolve only after that point. Repeat with `applyUpstream` rejecting instead of resolving: assert both B and C reject with `CaddyRepointError`, `gen` ends up `null`, and the lock is not wedged for a subsequent caller.

**Cross-tunnel `stopTunnel` interaction with a queued waiter (new, addresses residual risk in §6 finding 12):** a waiter is queued for port 4000 behind a holder on port 3000; the session's `onPortChanged` fires (simulating a Caddy crash-respawn) and evicts the tunnel while the waiter is still queued. Assert the queued waiter's eventual `claim()` attempt fails cleanly with a `CaddyRepointError`/connection-refused-shaped error (because `applyUpstream` now targets a stopped Caddy instance) rather than hanging or corrupting `TunnelInfo`/registry state — `stopTunnel`'s unconditional-removal contract (§2.3) means the next fresh call for that session key is unaffected regardless of how this in-flight waiter resolves.

### 5.5 New tests — concurrency at the TunnelManager layer

**Concurrent cold-start dedup (new, closes review finding):** two near-simultaneous `ensureSessionTunnel()` calls for a session key with no existing tunnel and no in-flight creation. Assert exactly one `caddyFactory()` call, one `ensureStarted()` call, and one `connectWithRetry`/`ngrok.connect` call total; assert both callers resolve to the identical `TunnelInfo` object (`===`, not just equal `tunnelId`). Repeat with the creation's `connectWithRetry` rejecting: assert both callers reject, `pendingSessionTunnels` and `sessionTunnels` both end up with no entry for the session key (not a half-registered state), and a subsequent call retries cleanly rather than replaying a cached failure.

**`stopTunnel` unconditional-removal ordering (new, closes review finding):** call `stopTunnel(tunnelId)` with `info.caddy.stop()` mocked to reject. Assert `activeTunnels`/`sessionTunnels` no longer contain the entry **synchronously relative to the rejection** (i.e., checked immediately after `stopTunnel`'s returned promise settles, regardless of which cleanup step failed), `stopTunnel`'s own returned promise still resolves (never rejects), and `Telemetry.capture(TUNNEL_TEARDOWN_PARTIAL_FAILURE, ...)` fired once per failed step.

**`trigger_crawl` lock-wiring parity test (new, closes review finding):** assert `triggerCrawlHandler` calls `acquirePortRoute` after `ensureTunnel`/before `probeTunnelHealth` and `releasePortRoute` in its `finally`, identically to `check_app_in_browser`/`probe_page` — a structural test that would fail loudly if a future refactor accidentally moved `trigger_crawl` onto the `run_test_suite`-style dedicated-tunnel path (or vice versa).

### 5.6 New tests — the two findings from the migration pass

`probe_page` multi-port batch behavior: same-port batch still one dispatch; cross-port batch decomposes into per-port sequential sub-dispatches producing one merged `ProbePageResult[]`, not a mid-batch 404. `sanitizeResponseUrls` cross-attribution: a two-target, cross-port batch where both targets' captured data contain the shared tunnel hostname string — assert each result is rewritten to *its own* target's localhost origin. `run_test_suite`'s new defensive `sanitizeResponseUrls` call is exercised by a test asserting a widened mock backend response gets its tunnel hostname stripped.

### 5.7 Docs to update

`README.md` — the `probe_page` claim "the whole batch shares a single backend execution + browser session + tunnel" needs a caveat for cross-port batches; the tunnel-URL-stripping claim should not be re-asserted as unconditionally true until the cross-attribution fix lands. Rollout/setup docs — add **two** explicit go/no-go deployment preconditions, not footnotes: (1) the `caddy` binary must be on `PATH` (nothing auto-installs it, §4); (2) HTTP-transport multi-replica deployments must configure session-affine LB routing keyed on the caller's session key (§2.1), or accept the documented bounded degrade. New `docs/` architecture note (this document) owns the final `CaddyProxy`/`PortLock` public interfaces and the per-session-key isolation decision, specifically so the wildcard-hostname dead end and the Feb root cause aren't re-litigated later.

---

## 6. Open risks / explicitly deferred non-goals

- **Caddy binary is a new hard runtime dependency with no auto-install in v1.** Breaks the "zero-config `npx @debugg-ai/debugg-ai-mcp`" promise until either documented clearly as a prerequisite or a postinstall downloader is built as a fast-follow. Needs an explicit go/no-go before cutover, alongside the LB-affinity precondition (§2.1).
- **No cold-start progress signal.** The lock has `onWaitProgress` for queueing, but the very first call of a session gets silence through Caddy spawn (up to ~5s) plus the ngrok connect retry ladder, with no interim signal analogous to the queueing UX. Minor UX inconsistency, not a correctness gap; a fast follow would emit a `{message: "Starting local tunnel..."}` progress tick around `caddy.ensureStarted()`/`connectWithRetry()`.
- **`CaddyBinaryNotFoundError` surfacing at the actual tool-response layer is not fully traced.** The error class and its unit tests are defined at the Caddy-service layer; it should be caught in the handler layer (the same `handleExternalServiceError`/`errorResponse` pattern already used elsewhere) and turned into a clear, actionable tool-response error rather than an uncaught throw, but the exact catch site and message copy are not specified here — track as a fast follow alongside the binary-distribution decision itself.
- **`getSessionKey()`'s fallback to `'stdio'` when `currentApiKey()` is unset.** If any HTTP code path can reach tunnel logic without an API key already resolved in `AsyncLocalStorage`, it collapses onto the same session key as every stdio process and every other such caller — reintroducing the cross-tenant bug §2.1 exists to fix. The pseudocode in §2.1 now logs loudly (`logger.error`) when this fallback fires so it surfaces in practice; whether it's actually reachable depends on upstream auth being mandatory, which is asserted nowhere in this repo and should be verified as a fast follow, with a hard throw substituted for the fallback if it's confirmed unreachable.
- **`probe_page` multi-port batch partial-failure semantics are unspecified** — does one failing port-group fail the whole batch or produce a partial merged result? Minor completeness gap, to be resolved during implementation of §4's decomposition decision.
- **Mid-dispatch Caddy crash has no active repair.** If Caddy dies while a call is holding the lock and *not* about to call `setUpstream` again (a same-port joiner making direct requests through the tunnel), nothing detects or repairs the gap until some *other* call's `acquire()`/`setUpstream()` happens to trigger the lazy respawn-on-dead-process path in `adminRequest()`. The in-flight request(s) will fail/reset during that window. Accepted as a rare, crash-triggered edge case.
- **Queued-waiter behavior during a concurrent crash/`onPortChanged` eviction of the same session's tunnel.** A promoted waiter's `claim()` can call `setUpstream` on a Caddy instance that was `.stop()`'d by the eviction handler moments earlier, in the narrow window where both a crash and a queued different-port call coincide. §2.3's unconditional-removal fix ensures this never corrupts shared `TunnelInfo`/registry state — the affected waiter's own call fails cleanly with `CaddyRepointError` (§5.4's dedicated test) — but that one call is still a real, user-visible failure with no automatic retry. Rare; not actively repaired here.
- **`onPortChanged`-triggered session-tunnel eviction is disruptive.** When a crash-respawn lands on a new proxy port, the whole session tunnel is torn down and must be fully recreated (new hostname) on the next call — any call in flight at that moment fails outright. Rare, but real; not silently masked.
- **`probe_page` cross-port batches get slower, not just architecturally different.** N sequential backend round-trips instead of one shared execution is a real, user-visible latency regression for the (uncommon) cross-port-batch case, explicitly signed off in §4 rather than silently absorbed.
- **`run_test_suite` is a permanent, named exception to "one tunnel per session."** It cannot fold into the shared model without a larger behavior change to the tool itself (polling for suite completion, or a completion webhook) — out of scope here.
- **The registry's remaining job is purely observational.** An over-eager prune or a `$TMPDIR`-split process (bead `fcbm`) can now only corrupt the diagnostic view, never correctness — a deliberate, accepted downgrade in what the registry is trusted for.
- **HTTP multi-replica deployments without the §2.1 affinity precondition** degrade to bounded, cost-only double-provisioning rather than achieving the full "one tunnel per session" win — an accepted, documented shortfall for that specific deployment shape, not a silent failure (see §2.1/§4 for the full reasoning and the honest degrade path).
- **The Caddy admin API `@id`/PATCH semantics in §2.2 are unverified against a real Caddy binary/version** — integration test §5.3's "regression test for the Feb root cause," the Host-header round-trip test, and the PATCH round-trip test exist specifically to catch a wrong assumption here before it reaches production; do not consider this design validated until those pass against the actual Caddy version pinned for ship.
- **Self-recovery across an MCP process crash is deliberately not rebuilt.** The old `reconcileWithLocalAgents()` adoption logic is not replaced with a per-session equivalent — under the new model, recovering a dead-Caddy/live-ngrok-tunnel orphan doesn't restore a working tunnel anyway (every request 502s until repointed again), and the maximum possible saving is now one tunnel-hour, not N. The existing 55-minute idle auto-shutoff bounds the cost of any abnormal exit, same as today.

---

## Status

Architecture pass complete: four source designs merged, then adversarially reviewed. All six review findings marked blocking are fixed inline above with concrete mechanisms (not acknowledgments) and matching new regression tests (§5.3-§5.5): the queue-promotion race (§2.4), the cold-start creation TOCTOU (§2.3), the HTTP multi-replica affinity gap (§2.1, now a documented deployment precondition with an honest degrade path), the unspecified Host-header policy (§2.2, now a verified hold-the-line contract with a snapshot test), the unverified `trigger_crawl` execution model (§2.3, verified by reading the handler — it polls, it is not a second exception), and the `onPortChanged` cleanup-ordering gap (§2.3, now an unconditional-removal contract). Six further findings judged survivable for a v1 are logged in §6 with enough detail to pick up as fast follows. Next: implementation against subtasks `.3` (Caddy service) and `.4` (TunnelManager rewire), gated on the integration tests in §5.3 passing against the real pinned Caddy binary before cutover (`.5`).
