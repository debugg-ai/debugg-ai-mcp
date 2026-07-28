/**
 * File-backed tunnel registry tests (bead fcbm).
 *
 * The file registry had no coverage at all, which is how it kept a path that
 * silently partitioned by launch context for so long. These exercise the REAL
 * filesystem — via DEBUGG_AI_TUNNEL_REGISTRY pointed at a throwaway directory —
 * because the whole bug was about where bytes land, and a mocked `fs` cannot
 * observe that.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  createFileRegistry,
  getRegistryFilePath,
  getLegacyRegistryFilePath,
  type RegistryEntry,
} from '../../services/ngrok/tunnelRegistry.js';

const ORIGINAL_OVERRIDE = process.env.DEBUGG_AI_TUNNEL_REGISTRY;
let workdir: string;

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    tunnelId: 't1',
    publicUrl: 'https://t1.ngrok.debugg.ai/',
    tunnelUrl: 'https://t1.ngrok.debugg.ai',
    port: 3000,
    ownerPid: process.pid,
    lastAccessedAt: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'debugg-ai-registry-test-'));
});

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) delete process.env.DEBUGG_AI_TUNNEL_REGISTRY;
  else process.env.DEBUGG_AI_TUNNEL_REGISTRY = ORIGINAL_OVERRIDE;
  rmSync(workdir, { recursive: true, force: true });
});

describe('bead fcbm: registry path is independent of how the process was launched', () => {
  test('default path is under the home directory, NOT tmpdir()', () => {
    delete process.env.DEBUGG_AI_TUNNEL_REGISTRY;
    const path = getRegistryFilePath();
    expect(path).toBe(join(homedir(), '.debugg-ai', 'tunnels.json'));
    expect(path.startsWith(tmpdir())).toBe(false);
  });

  test('$TMPDIR cannot move the registry — the whole point of the bead', () => {
    delete process.env.DEBUGG_AI_TUNNEL_REGISTRY;
    const before = getRegistryFilePath();
    const originalTmpdir = process.env.TMPDIR;
    try {
      // Two MCPs launched differently (launchd vs a scrubbed shell vs Docker)
      // used to land on two different files and never see each other's tunnels.
      process.env.TMPDIR = '/some/other/tmp';
      expect(getRegistryFilePath()).toBe(before);
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }
  });

  test('DEBUGG_AI_TUNNEL_REGISTRY overrides the default', () => {
    process.env.DEBUGG_AI_TUNNEL_REGISTRY = '/mnt/shared/tunnels.json';
    expect(getRegistryFilePath()).toBe('/mnt/shared/tunnels.json');
  });

  test('blank override falls back to the default rather than writing to ""', () => {
    process.env.DEBUGG_AI_TUNNEL_REGISTRY = '   ';
    expect(getRegistryFilePath()).toBe(join(homedir(), '.debugg-ai', 'tunnels.json'));
  });

  test('the path is resolved per call, so an override set after import still applies', () => {
    delete process.env.DEBUGG_AI_TUNNEL_REGISTRY;
    const before = getRegistryFilePath();
    process.env.DEBUGG_AI_TUNNEL_REGISTRY = join(workdir, 'late.json');
    expect(getRegistryFilePath()).not.toBe(before);
  });
});

describe('file registry read/write', () => {
  test('creates the containing directory on first write', () => {
    const file = join(workdir, 'nested', 'deeper', 'tunnels.json');
    const reg = createFileRegistry(file);
    reg.write({ '3000': entry() });
    expect(existsSync(file)).toBe(true);
    expect(reg.read()['3000'].tunnelId).toBe('t1');
  });

  test('round-trips entries and leaves no .tmp file behind (atomic rename)', () => {
    const file = join(workdir, 'tunnels.json');
    const reg = createFileRegistry(file);
    reg.write({ '3000': entry(), '4000': entry({ tunnelId: 't2', port: 4000 }) });

    expect(Object.keys(reg.read()).sort()).toEqual(['3000', '4000']);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
    // A second reader (another process) sees the same bytes.
    expect(JSON.parse(readFileSync(file, 'utf8'))['4000'].tunnelId).toBe('t2');
  });

  test('missing file reads as empty, never throws', () => {
    const reg = createFileRegistry(join(workdir, 'absent.json'));
    expect(reg.read()).toEqual({});
  });

  test('corrupt file reads as empty rather than blocking tunnel creation', () => {
    const file = join(workdir, 'corrupt.json');
    writeFileSync(file, '{ not json at all');
    expect(createFileRegistry(file).read()).toEqual({});
  });

  test('a JSON array is rejected — only an object is a registry', () => {
    const file = join(workdir, 'array.json');
    writeFileSync(file, '[1,2,3]');
    expect(createFileRegistry(file).read()).toEqual({});
  });
});

describe('bead fcbm: legacy tmpdir() registry is merged, not abandoned or destroyed', () => {
  // The legacy path is INJECTED, never redirected via $TMPDIR. os.tmpdir() does
  // not observe an env change made inside a Jest realm, so an env-based attempt
  // reads and rewrites the developer's REAL registry — which is exactly what
  // happened while writing these tests.
  function withLegacy(name: string, contents: Record<string, RegistryEntry>): string {
    const legacyFile = join(workdir, `${name}-legacy.json`);
    writeFileSync(legacyFile, JSON.stringify(contents));
    return legacyFile;
  }

  test('the injected legacy path is not the machine-wide one by default', () => {
    // Guards the seam itself: if the default ever stopped pointing at tmpdir(),
    // migration would silently stop finding anything.
    expect(getLegacyRegistryFilePath()).toBe(join(tmpdir(), 'debugg-ai-tunnels.json'));
  });

  test('entries at the legacy path are adopted on first read', () => {
    const legacy = withLegacy('a', { '3011': entry({ tunnelId: 'legacy-t', port: 3011 }) });
    const reg = createFileRegistry(join(workdir, 'stable-a.json'), legacy);
    expect(reg.read()['3011'].tunnelId).toBe('legacy-t');
  });

  test('the legacy file is left intact — deleting it would make an older MCP re-provision', () => {
    const legacy = withLegacy('b', { '3011': entry({ tunnelId: 'legacy-t', port: 3011 }) });
    createFileRegistry(join(workdir, 'stable-b.json'), legacy);
    expect(existsSync(legacy)).toBe(true);
    expect(JSON.parse(readFileSync(legacy, 'utf8'))['3011'].tunnelId).toBe('legacy-t');
  });

  test('the fresher record wins when both files know the port', () => {
    const now = Date.now();
    const legacy = withLegacy('c', {
      '3011': entry({ tunnelId: 'legacy-newer', port: 3011, lastAccessedAt: now }),
    });
    const stable = join(workdir, 'stable-c.json');
    writeFileSync(stable, JSON.stringify({
      '3011': entry({ tunnelId: 'stable-older', port: 3011, lastAccessedAt: now - 60_000 }),
    }));

    expect(createFileRegistry(stable, legacy).read()['3011'].tunnelId).toBe('legacy-newer');
  });

  test('a stale legacy record does NOT clobber a fresher one on the stable path', () => {
    const now = Date.now();
    const legacy = withLegacy('d', {
      '3011': entry({ tunnelId: 'legacy-older', port: 3011, lastAccessedAt: now - 60_000 }),
    });
    const stable = join(workdir, 'stable-d.json');
    writeFileSync(stable, JSON.stringify({
      '3011': entry({ tunnelId: 'stable-newer', port: 3011, lastAccessedAt: now }),
    }));

    expect(createFileRegistry(stable, legacy).read()['3011'].tunnelId).toBe('stable-newer');
  });

  test('ports only the legacy file knows about are added alongside the stable ones', () => {
    const legacy = withLegacy('g', { '3011': entry({ tunnelId: 'only-legacy', port: 3011 }) });
    const stable = join(workdir, 'stable-g.json');
    writeFileSync(stable, JSON.stringify({ '4000': entry({ tunnelId: 'only-stable', port: 4000 }) }));

    const merged = createFileRegistry(stable, legacy).read();
    expect(merged['3011'].tunnelId).toBe('only-legacy');
    expect(merged['4000'].tunnelId).toBe('only-stable');
  });

  test('malformed legacy entries are skipped, valid siblings still merge', () => {
    const legacy = withLegacy('e', {
      '3011': entry({ tunnelId: 'good', port: 3011 }),
      '4011': { nonsense: true } as unknown as RegistryEntry,
    });
    const merged = createFileRegistry(join(workdir, 'stable-e.json'), legacy).read();
    expect(merged['3011'].tunnelId).toBe('good');
    expect(merged['4011']).toBeUndefined();
  });

  test('no legacy file → nothing is written and the stable path stays absent', () => {
    const stable = join(workdir, 'stable-f.json');
    createFileRegistry(stable, join(workdir, 'no-such-legacy.json'));
    expect(existsSync(stable)).toBe(false);
  });

  test('migration is one-shot per path — a re-read does not resurrect what was pruned', () => {
    const legacy = withLegacy('h', { '3011': entry({ tunnelId: 'legacy-t', port: 3011 }) });
    const stable = join(workdir, 'stable-h.json');

    const first = createFileRegistry(stable, legacy);
    expect(first.read()['3011']).toBeDefined();
    first.write({}); // e.g. startup prune swept it

    // A second registry over the same path must not drag the legacy entry back.
    expect(createFileRegistry(stable, legacy).read()).toEqual({});
  });
});

// ── rollout overlap ─────────────────────────────────────────────────────────
// Moving the registry path partitions us against MCPs still running the old
// build, which keep writing tmpdir(). A one-shot migration only catches what
// exists at our startup; long-lived old sessions provision tunnels for days
// afterwards. Missing those means buying a duplicate — a 1-hour minimum charge.

describe('legacy registry overlap during rollout', () => {
  test('sees a tunnel an old build registered AFTER our migration ran', () => {
    const reg = createFileRegistry(join(workdir, 'new.json'), join(workdir, 'legacy.json'));
    expect(reg.read()).toEqual({});

    // An old-build MCP provisions :4100 later and writes only to tmpdir().
    writeFileSync(join(workdir, 'legacy.json'), JSON.stringify({
      '4100': {
        tunnelId: 'old-build-tunnel',
        publicUrl: 'https://old.ngrok.debugg.ai',
        tunnelUrl: 'https://old.ngrok.debugg.ai',
        port: 4100,
        ownerPid: process.pid,
        lastAccessedAt: Date.now(),
      },
    }));

    expect(reg.read()['4100']?.tunnelId).toBe('old-build-tunnel');
  });

  test('our fresher record wins over a stale legacy one for the same port', () => {
    const reg = createFileRegistry(join(workdir, 'new.json'), join(workdir, 'legacy.json'));
    const stale = {
      tunnelId: 'stale', publicUrl: 'https://s.ngrok.debugg.ai',
      tunnelUrl: 'https://s.ngrok.debugg.ai', port: 4101,
      ownerPid: process.pid, lastAccessedAt: 1_000,
    };
    writeFileSync(join(workdir, 'legacy.json'), JSON.stringify({ '4101': stale }));
    reg.write({ '4101': { ...stale, tunnelId: 'ours', lastAccessedAt: 2_000 } });

    expect(reg.read()['4101'].tunnelId).toBe('ours');
  });

  test('the overlay never writes back to the legacy file', () => {
    const reg = createFileRegistry(join(workdir, 'new.json'), join(workdir, 'legacy.json'));
    const body = JSON.stringify({
      '4102': {
        tunnelId: 't', publicUrl: 'https://t.ngrok.debugg.ai',
        tunnelUrl: 'https://t.ngrok.debugg.ai', port: 4102,
        ownerPid: process.pid, lastAccessedAt: Date.now(),
      },
    });
    writeFileSync(join(workdir, 'legacy.json'), body);
    reg.read();
    // Byte-identical: an old build still reading this file must be unaffected.
    expect(readFileSync(join(workdir, 'legacy.json'), 'utf8')).toBe(body);
  });
});
