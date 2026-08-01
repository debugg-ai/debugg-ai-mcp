/**
 * Cross-process tunnel registry — WRITE-MOSTLY OBSERVABILITY ONLY.
 *
 * Under the old per-port model this registry was load-bearing for
 * correctness: it was how a second MCP instance on the same machine
 * discovered and BORROWED an existing tunnel instead of provisioning a
 * duplicate for the same port. That borrowing mechanism (and everything that
 * existed only to make it safe — freshness TTLs, PID-reuse defenses,
 * adopt/reconcile against the local ngrok agent) is retired outright by
 * docs/local-tunnel-multiplexer-architecture-2026-07-31.md §4: "No sharing,
 * ever, at any granularity. Each session key gets its own Caddy instance and
 * its own ngrok tunnel."
 *
 * What remains is a diagnostic view: `RegistryEntry` rows, keyed by
 * `tunnelId` (not port — a port no longer identifies anything unique once
 * one Caddy instance can be repointed across many ports, and one HTTP-mode
 * process can host many session keys sharing one port namespace). Nothing in
 * `TunnelManager` reads this registry to make a reuse/borrow decision
 * anymore; it only writes to it (best-effort) so `~/.debugg-ai/tunnels.json`
 * stays useful for a human debugging "what tunnels does this machine have
 * open." An over-eager prune or a `$TMPDIR`-split process (bead `fcbm`) can
 * therefore only corrupt the diagnostic view now, never correctness — a
 * deliberate, accepted downgrade in what this file is trusted for (§6).
 *
 * The file registry uses an atomic rename-write so concurrent processes never
 * see a partial JSON file.  All operations are best-effort — errors are
 * swallowed so a broken registry never blocks tunnel creation.
 *
 * Bead `fcbm` — WHERE the file lives is load-bearing. It used to be
 * `join(tmpdir(), 'debugg-ai-tunnels.json')`, and `os.tmpdir()` honours
 * `$TMPDIR`, which is not a property of the machine — it is a property of how
 * the process was LAUNCHED. Under launchd it is a per-user
 * `/var/folders/<...>/T`; a shell with a scrubbed environment gets `/tmp`; the
 * Docker image gets `/tmp`. Two MCPs started differently therefore kept two
 * SEPARATE registries and never saw each other's diagnostic rows.
 *
 * So the path is pinned to `~/.debugg-ai/tunnels.json`, which is the same file
 * for the same user no matter how the process was started, with a
 * `DEBUGG_AI_TUNNEL_REGISTRY` override for containers that mount a shared
 * volume elsewhere. Anything found at the legacy tmpdir() path is merged in
 * once, so rows already written on the old path stay visible.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RegistryEntry {
  tunnelId: string;
  /** §2.1 — identifies the caller this tunnel is scoped to (a process for
   *  stdio, a hashed bearer token for HTTP). Purely diagnostic here. */
  sessionKey: string;
  /** `publicUrl` and `tunnelUrl` are now the SAME value — path-baking per
   *  caller is gone now that a session tunnel's hostname never changes and
   *  Caddy owns all local-port routing. Kept as two fields for continuity
   *  with the pre-cutover shape rather than a breaking rename. */
  publicUrl: string;
  tunnelUrl: string;
  /** This session's Caddy admin API port — diagnostic only, lets a human
   *  correlate a registry row with a running `caddy` process. `-1` for a
   *  tunnel that bypasses Caddy entirely (the `run_test_suite` exception,
   *  §2.3's `acquireDedicatedTunnel`). */
  caddyAdminPort: number;
  ownerPid: number;
  lastAccessedAt: number;
}

export type RegistryData = Record<string, RegistryEntry>; // key = tunnelId

export interface RegistryStore {
  read(): RegistryData;
  write(data: RegistryData): void;
  isPidAlive(pid: number): boolean;
  /**
   * Remove entries whose owner PID is dead. A PURE liveness filter now —
   * unlike the pre-cutover version, there is no `staleAfterMs` freshness
   * window: that window existed solely to protect borrow decisions (bead
   * `3th`'s PID-reuse defense), and nothing borrows from this registry
   * anymore. A dead-owner row is simply a diagnostic row for a process that
   * no longer exists, so it is always safe to drop.
   *
   * Bead `mdp`: scan-and-prune on TunnelManager startup; prevents the
   * registry from growing unboundedly when MCPs exit without calling
   * stopAllTunnels (SIGKILL, crash).
   */
  prune(opts?: { nowMs?: number }): { pruned: number; remaining: number };
}

// ── File location ─────────────────────────────────────────────────────────────

/**
 * The pre-fcbm location. Still READ (and merged from) so rows written by an
 * older build, or by a build whose $TMPDIR differed, are not stranded.
 *
 * Never written to, and never deleted: a still-running older MCP may be
 * reading it.
 */
export function getLegacyRegistryFilePath(): string {
  return join(tmpdir(), 'debugg-ai-tunnels.json');
}

/**
 * The registry path for this machine+user. Resolved per call (not cached at
 * module load) so an override can be set before the registry is constructed.
 */
export function getRegistryFilePath(): string {
  const override = process.env.DEBUGG_AI_TUNNEL_REGISTRY?.trim();
  if (override) return override;
  return join(homedir(), '.debugg-ai', 'tunnels.json');
}

/** Paths already merged in this process — the legacy merge is a one-shot. */
const migratedPaths = new Set<string>();

/**
 * Per-path watermark: when we last wrote a complete view of this registry.
 *
 * The read-side legacy overlay needs to tell two cases apart that look identical
 * in the file: a row we have ALREADY considered and deliberately swept, and
 * one an old-build MCP wrote after we swept. A `lastAccessedAt` relative to
 * our last write separates them.
 */
const sweptAt = new Map<string, number>();

// ── File-backed implementation (production) ───────────────────────────────────

/**
 * Both paths are parameters rather than module constants so tests can point at
 * a throwaway directory. That matters more than it looks: the legacy path is a
 * real machine-wide file that a running MCP may depend on, and `os.tmpdir()`
 * does not observe a `TMPDIR` set inside a Jest realm — so a test that tried to
 * redirect it by environment would silently read and REWRITE the developer's
 * actual registry.
 */
export function createFileRegistry(
  registryFile: string = getRegistryFilePath(),
  legacyFile: string = getLegacyRegistryFilePath(),
): RegistryStore {
  const store: RegistryStore = {
    read(): RegistryData {
      // Overlay the legacy registry on EVERY read, not just once at startup —
      // see mergeLegacyRegistry()'s doc comment for why a one-shot merge at
      // process start is not enough during a rollout.
      return overlayLegacy(readRegistryFile(registryFile), legacyFile, registryFile);
    },

    write(data: RegistryData): void {
      const tmp = `${registryFile}.${process.pid}.tmp`;
      try {
        // 0o700: the registry names every local tunnel this user has open.
        mkdirSync(dirname(registryFile), { recursive: true, mode: 0o700 });
        writeFileSync(tmp, JSON.stringify(data));
        // Same directory as the target, so the rename is same-filesystem and
        // therefore actually atomic.
        renameSync(tmp, registryFile);
        // We have just published a complete view; anything older in the legacy
        // file has already been considered (and possibly swept) by us.
        sweptAt.set(registryFile, Date.now());
      } catch {
        // best-effort
      }
    },

    isPidAlive(pid: number): boolean {
      return checkPid(pid);
    },

    prune(opts) {
      return pruneRegistryData(store, opts);
    },
  };

  mergeLegacyRegistry(store, registryFile, legacyFile);
  return store;
}

/**
 * One-shot merge of the legacy tmpdir() registry into the stable one.
 *
 * Merge, not move: a row only wins if this path has nothing for that
 * tunnelId or has something older. A tunnel both files know about keeps
 * whichever record was touched most recently.
 */
function mergeLegacyRegistry(store: RegistryStore, registryFile: string, legacyFile: string): void {
  if (legacyFile === registryFile || migratedPaths.has(registryFile)) return;
  migratedPaths.add(registryFile);

  const legacy = readRegistryFile(legacyFile);
  const ids = Object.keys(legacy);
  if (ids.length === 0) return;

  const current = store.read();
  let merged = 0;
  for (const id of ids) {
    const entry = legacy[id];
    if (!isRegistryEntry(entry)) continue;
    const mine = current[id];
    if (!mine || entry.lastAccessedAt > mine.lastAccessedAt) {
      current[id] = entry;
      merged++;
    }
  }
  if (merged > 0) store.write(current);
}

/**
 * Merge the legacy registry over `current` in memory, fresher record winning.
 * Read-side only — never writes.
 */
function overlayLegacy(current: RegistryData, legacyFile: string, registryFile: string): RegistryData {
  if (legacyFile === registryFile) return current;
  const watermark = sweptAt.get(registryFile) ?? 0;
  const legacy = readRegistryFile(legacyFile);
  for (const [id, entry] of Object.entries(legacy)) {
    if (!isRegistryEntry(entry)) continue;
    // Older than our last complete write => we already saw it and chose not
    // to keep it (or it belongs to a tunnel that no longer exists).
    if (entry.lastAccessedAt <= watermark) continue;
    const mine = current[id];
    if (!mine || entry.lastAccessedAt > mine.lastAccessedAt) current[id] = entry;
  }
  return current;
}

function readRegistryFile(file: string): RegistryData {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as RegistryData;
  } catch {
    return {};
  }
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  const e = value as RegistryEntry | undefined;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.tunnelId === 'string' &&
    typeof e.sessionKey === 'string' &&
    typeof e.ownerPid === 'number' &&
    typeof e.lastAccessedAt === 'number'
  );
}

// ── In-memory implementation (tests / injectable) ─────────────────────────────

export function createInMemoryRegistry(
  isPidAliveImpl?: (pid: number) => boolean,
): RegistryStore {
  let data: RegistryData = {};
  const store: RegistryStore = {
    read: () => ({ ...data }),
    write: (next) => { data = { ...next }; },
    isPidAlive: isPidAliveImpl ?? checkPid,
    prune: (opts) => pruneRegistryData(store, opts),
  };
  return store;
}

// ── No-op implementation (tests that don't exercise registry) ─────────────────

export const noopRegistry: RegistryStore = {
  read: () => ({}),
  write: () => {},
  isPidAlive: () => false,
  prune: () => ({ pruned: 0, remaining: 0 }),
};

// ── Default selection ─────────────────────────────────────────────────────────

/**
 * Returns the appropriate registry for the current environment.
 * Tests (NODE_ENV=test) get the no-op registry; production gets file-backed.
 */
export function getDefaultRegistry(): RegistryStore {
  return process.env.NODE_ENV === 'test' ? noopRegistry : createFileRegistry();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkPid(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no signal sent
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared prune logic — read, filter, write back. Used by both the file-backed
 * and in-memory implementations so the eviction policy lives in one place.
 *
 * Eviction rule: drop entries whose owner PID is dead. That's the whole
 * rule now — see the `prune()` doc comment on `RegistryStore` for why the
 * old freshness window is gone.
 */
function pruneRegistryData(
  store: RegistryStore,
  _opts?: { nowMs?: number },
): { pruned: number; remaining: number } {
  const data = store.read();
  const next: RegistryData = {};
  let pruned = 0;
  for (const [id, entry] of Object.entries(data)) {
    if (store.isPidAlive(entry.ownerPid)) {
      next[id] = entry;
    } else {
      pruned++;
    }
  }
  if (pruned > 0) store.write(next);
  return { pruned, remaining: Object.keys(next).length };
}
