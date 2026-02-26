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
}

// ── File-backed implementation (production) ───────────────────────────────────

const REGISTRY_FILE = join(tmpdir(), 'debugg-ai-tunnels.json');

export function createFileRegistry(): RegistryStore {
  return {
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
  };
}

// ── In-memory implementation (tests / injectable) ─────────────────────────────

export function createInMemoryRegistry(
  isPidAliveImpl?: (pid: number) => boolean,
): RegistryStore {
  let store: RegistryData = {};
  return {
    read: () => ({ ...store }),
    write: (data) => { store = { ...data }; },
    isPidAlive: isPidAliveImpl ?? checkPid,
  };
}

// ── No-op implementation (tests that don't exercise registry) ─────────────────

export const noopRegistry: RegistryStore = {
  read: () => ({}),
  write: () => {},
  isPidAlive: () => false,
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
