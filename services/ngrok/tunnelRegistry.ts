/**
 * Cross-process tunnel registry.
 *
 * Lets multiple MCP server instances on the same machine discover and share
 * ngrok tunnels instead of each provisioning a duplicate for the same port.
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
 * SEPARATE registries, never saw each other's tunnels, and provisioned a
 * duplicate per port — silently and permanently. At a 1-hour minimum charge per
 * tunnel that is a guaranteed double-bill, not an edge case.
 *
 * So the path is pinned to `~/.debugg-ai/tunnels.json`, which is the same file
 * for the same user no matter how the process was started, with a
 * `DEBUGG_AI_TUNNEL_REGISTRY` override for containers that mount a shared
 * volume elsewhere. Anything found at the legacy tmpdir() path is merged in
 * once, so tunnels already paid for on the old path stay discoverable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RegistryEntry {
  tunnelId: string;
  publicUrl: string;
  tunnelUrl: string;
  port: number;
  ownerPid: number;
  lastAccessedAt: number;
}

export type RegistryData = Record<string, RegistryEntry>; // key = port as string

export interface RegistryStore {
  read(): RegistryData;
  write(data: RegistryData): void;
  isPidAlive(pid: number): boolean;
  /**
   * Remove entries whose owner PID is dead OR whose `lastAccessedAt` is older
   * than `staleAfterMs`. Returns the number pruned.
   *
   * The freshness check defends against PID-reuse (bead 3th): even if the OS
   * has reassigned a dead owner's PID to a different process, an entry no
   * one is touching will fall outside the freshness window and get pruned.
   *
   * Bead `mdp`: scan-and-prune on TunnelManager startup; prevents the
   * registry from growing unboundedly when MCPs exit without calling
   * stopAllTunnels (SIGKILL, crash).
   *
   * Bead `lc62`: pruning deletes a MAP KEY. It has no ngrok reference and
   * cannot stop a tunnel — a pruned entry whose tunnel is still up is a live,
   * billing tunnel that has merely become undiscoverable. That is why
   * TunnelManager re-registers tunnels it owns and re-adopts live ones from the
   * local ngrok agent, instead of this function being taught to shut anything
   * down. Teardown here would cost two billed hours per idle gap.
   */
  prune(opts: { staleAfterMs: number; nowMs?: number }): { pruned: number; remaining: number };
}

// ── File location ─────────────────────────────────────────────────────────────

/**
 * The pre-fcbm location. Still READ (and merged from) so tunnels provisioned by
 * an older build, or by a build whose $TMPDIR differed, are not stranded.
 *
 * Never written to, and never deleted: a still-running older MCP is reading it,
 * and removing its entries would make it re-provision — the exact double-bill
 * this bead exists to stop.
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
 * in the file: an entry we have ALREADY considered and deliberately swept, and
 * one an old-build MCP wrote after we swept. Resurrecting the first hands a dead
 * tunnel to the next borrower (bead k34o); missing the second buys a duplicate.
 * An entry's `lastAccessedAt` relative to our last write separates them.
 *
 * Ties and clock skew resolve toward NOT resurrecting, because the two mistakes
 * are not equal: a dead entry breaks a run, a missed one costs an hour we were
 * already spending before this path moved.
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
      // Overlay the legacy registry on EVERY read, not just once at startup.
      //
      // Moving the path partitions us against every MCP still running the old
      // build, which keeps writing to tmpdir() — i.e. for the length of the
      // rollout this change would REINTRODUCE the split-registry double-billing
      // it exists to fix. That window is not short: long-lived sessions here run
      // for days, so a one-shot merge at process start would miss every tunnel
      // an old build provisions afterwards.
      //
      // Reading both and preferring the fresher record closes the direction that
      // matters — new builds see old builds' tunnels and borrow them instead of
      // buying duplicates. The reverse (old builds seeing ours) cannot be fixed
      // from this side without dual-writing, which would hand the old code a file
      // it may prune on our behalf; it resolves as old sessions exit.
      //
      // Cost is one extra existsSync + small JSON read per lookup, against a
      // 1-hour minimum charge for getting it wrong.
      return overlayLegacy(readRegistryFile(registryFile), legacyFile, registryFile);
    },

    write(data: RegistryData): void {
      const tmp = `${registryFile}.${process.pid}.tmp`;
      try {
        // 0o700: the registry names every local port this user is exposing.
        // Also covers a first run where ~/.debugg-ai does not exist yet, and a
        // later run where someone removed it.
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
 * Merge, not move: an entry only wins if this path has nothing for that port or
 * has something older. A tunnel that both files know about keeps whichever
 * record was touched most recently, which is the one whose `lastAccessedAt`
 * actually reflects use.
 */
function mergeLegacyRegistry(store: RegistryStore, registryFile: string, legacyFile: string): void {
  if (legacyFile === registryFile || migratedPaths.has(registryFile)) return;
  migratedPaths.add(registryFile);

  const legacy = readRegistryFile(legacyFile);
  const ports = Object.keys(legacy);
  if (ports.length === 0) return;

  const current = store.read();
  let merged = 0;
  for (const port of ports) {
    const entry = legacy[port];
    if (!isRegistryEntry(entry)) continue;
    const mine = current[port];
    if (!mine || entry.lastAccessedAt > mine.lastAccessedAt) {
      current[port] = entry;
      merged++;
    }
  }
  if (merged > 0) store.write(current);
}

/**
 * Merge the legacy registry over `current` in memory, fresher record winning.
 *
 * Read-side only — never writes. An old-build MCP that provisions a tunnel after
 * our one-shot migration ran is otherwise invisible to us, and we would buy a
 * duplicate for a port it already has covered.
 */
function overlayLegacy(current: RegistryData, legacyFile: string, registryFile: string): RegistryData {
  if (legacyFile === registryFile) return current;
  const watermark = sweptAt.get(registryFile) ?? 0;
  const legacy = readRegistryFile(legacyFile);
  for (const [port, entry] of Object.entries(legacy)) {
    if (!isRegistryEntry(entry)) continue;
    // Older than our last complete write => we already saw it and chose not to
    // keep it. Bringing it back would undo a prune and re-borrow a dead tunnel.
    if (entry.lastAccessedAt <= watermark) continue;
    const mine = current[port];
    if (!mine || entry.lastAccessedAt > mine.lastAccessedAt) current[port] = entry;
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
    typeof e.port === 'number' &&
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
 * Eviction rule: drop entries where EITHER the owner PID is dead OR the entry
 * hasn't been touched within `staleAfterMs`. The freshness check is what
 * defends against PID-reuse (bead 3th).
 */
function pruneRegistryData(
  store: RegistryStore,
  opts: { staleAfterMs: number; nowMs?: number },
): { pruned: number; remaining: number } {
  const now = opts.nowMs ?? Date.now();
  const data = store.read();
  const next: RegistryData = {};
  let pruned = 0;
  for (const [port, entry] of Object.entries(data)) {
    const aliveAndFresh =
      store.isPidAlive(entry.ownerPid) &&
      (now - entry.lastAccessedAt) <= opts.staleAfterMs;
    if (aliveAndFresh) {
      next[port] = entry;
    } else {
      pruned++;
    }
  }
  if (pruned > 0) store.write(next);
  return { pruned, remaining: Object.keys(next).length };
}
