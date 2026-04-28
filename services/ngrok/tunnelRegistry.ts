/**
 * Cross-process tunnel registry.
 *
 * Lets multiple MCP server instances on the same machine discover and share
 * ngrok tunnels instead of each provisioning a duplicate for the same port.
 *
 * The file registry uses an atomic rename-write so concurrent processes never
 * see a partial JSON file.  All operations are best-effort — errors are
 * swallowed so a broken registry never blocks tunnel creation.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
   */
  prune(opts: { staleAfterMs: number; nowMs?: number }): { pruned: number; remaining: number };
}

// ── File-backed implementation (production) ───────────────────────────────────

const REGISTRY_FILE = join(tmpdir(), 'debugg-ai-tunnels.json');

export function createFileRegistry(): RegistryStore {
  const store: RegistryStore = {
    read(): RegistryData {
      try {
        if (!existsSync(REGISTRY_FILE)) return {};
        return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
      } catch {
        return {};
      }
    },

    write(data: RegistryData): void {
      const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(data));
        renameSync(tmp, REGISTRY_FILE);
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
  return store;
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
