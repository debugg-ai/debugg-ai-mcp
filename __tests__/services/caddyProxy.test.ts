/**
 * CaddyProxy unit tests (mocked spawn/http).
 *
 * Covers docs/local-tunnel-multiplexer-architecture-2026-07-31.md §5.3:
 *  - Pure logic: resolveDialAddress() matrix, config builder, findFreePort()
 *  - setUpstream PATCH body always includes @id (the "LIFE-4" resend trap)
 *  - Idempotency (unchanged target vs. same-port-flipped-isHttpsLocal)
 *  - Lifecycle: spawn dedup, health-probe gating, ENOENT, crash/retry,
 *    sticky-port reclaim + onPortChanged, CaddyAdminApiError vs. respawn
 *  - Docker+HTTPS upstream matrix (exact PATCH body per combination)
 *
 * Real-`caddy`-binary integration tests live in
 * __tests__/integration/caddyProxy.test.ts (self-skips if caddy isn't on
 * PATH) — jest.unstable_mockModule below would shadow a real child_process/
 * http for the whole of this file, so they cannot coexist here.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import * as fsReal from 'node:fs';
import * as osReal from 'node:os';
import * as pathReal from 'node:path';

// Synchronous, load-time check (same self-skip shape as
// __tests__/integration/caddyProxy.test.ts's HAS_CADDY) — some CI jobs
// deliberately run `npm ci --ignore-scripts` (e.g. validate-setup.yml, to
// validate package structure without executing arbitrary postinstall code),
// so @radically-straightforward/caddy's postinstall never ran and
// node_modules/.bin/caddy genuinely does not exist there. That's not a bug in
// resolveCaddyBinary()'s fallback chain (it correctly falls through to a bare
// 'caddy' PATH lookup) — it's a real environment precondition the tests that
// assert "the bundled binary is present/used" must respect, not assume.
const BUNDLED_CADDY_BIN_NAME = process.platform === 'win32' ? 'caddy.exe' : 'caddy';
const HAS_BUNDLED_CADDY = fsReal.existsSync(
  pathReal.join(import.meta.dirname, '..', '..', 'node_modules', '.bin', BUNDLED_CADDY_BIN_NAME),
);
const maybeTest = HAS_BUNDLED_CADDY ? test : test.skip;
const maybeTestNoBundledBinary = HAS_BUNDLED_CADDY ? test.skip : test;

// ── Fake child_process.spawn ─────────────────────────────────────────────

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4242;
  kill = jest.fn((_signal?: string) => true);
}

let spawnedChildren: FakeChildProcess[] = [];
let spawnImpl: (cmd: string, args: string[], opts: unknown) => FakeChildProcess = () => {
  const child = new FakeChildProcess();
  spawnedChildren.push(child);
  return child;
};

const mockSpawn = jest.fn((cmd: string, args: string[], opts: unknown) => {
  const child = spawnImpl(cmd, args, opts);
  if (!spawnedChildren.includes(child)) spawnedChildren.push(child);
  return child;
});

jest.unstable_mockModule('child_process', () => ({
  spawn: mockSpawn,
}));

// ── Fake http.request (admin API + readiness probe) ────────────────────────

type HttpOutcome =
  | { kind: 'response'; status: number; body?: string }
  | { kind: 'error'; error: NodeJS.ErrnoException }
  | { kind: 'pending' };

interface RecordedHttpCall {
  method: string;
  path: string;
  body?: string;
}

let httpHandler: (options: { method?: string; path?: string }, body: string | undefined) => HttpOutcome = () => ({
  kind: 'response',
  status: 200,
  body: '',
});

let httpCalls: RecordedHttpCall[] = [];

const mockHttpRequest = jest.fn((options: any, callback?: (res: any) => void) => {
  const req: any = new EventEmitter();
  let written = '';
  req.write = jest.fn((chunk: any) => {
    written += chunk.toString();
  });
  req.destroy = jest.fn();
  req.end = jest.fn(() => {
    httpCalls.push({ method: options.method, path: options.path, body: written || undefined });
    const outcome = httpHandler(options, written || undefined);
    if (outcome.kind === 'pending') return;
    if (outcome.kind === 'error') {
      queueMicrotask(() => req.emit('error', outcome.error));
      return;
    }
    const res: any = new EventEmitter();
    res.statusCode = outcome.status;
    if (callback) callback(res);
    queueMicrotask(() => {
      if (outcome.body) res.emit('data', Buffer.from(outcome.body));
      res.emit('end');
    });
  });
  return req;
});

jest.unstable_mockModule('http', () => ({
  request: mockHttpRequest,
}));

// ── Import module under test (after mocks) ─────────────────────────────────

let CaddyProxyManager: typeof import('../../services/caddy/caddyProxy.js').CaddyProxyManager;
let resolveDialAddress: typeof import('../../services/caddy/caddyProxy.js').resolveDialAddress;
let buildCaddyConfig: typeof import('../../services/caddy/caddyProxy.js').buildCaddyConfig;
let buildPatchBody: typeof import('../../services/caddy/caddyProxy.js').buildPatchBody;
let findFreePort: typeof import('../../services/caddy/caddyProxy.js').findFreePort;
let CADDY_HANDLER_ID: string;
let CaddyBinaryNotFoundError: typeof import('../../services/caddy/caddyProxy.js').CaddyBinaryNotFoundError;
let CaddyStartupError: typeof import('../../services/caddy/caddyProxy.js').CaddyStartupError;
let CaddyAdminApiError: typeof import('../../services/caddy/caddyProxy.js').CaddyAdminApiError;
let CaddyPortReclaimError: typeof import('../../services/caddy/caddyProxy.js').CaddyPortReclaimError;
let sweepOrphanedConfigs: typeof import('../../services/caddy/caddyProxy.js').sweepOrphanedConfigs;
let _resetOrphanSweepForTests: typeof import('../../services/caddy/caddyProxy.js')._resetOrphanSweepForTests;
let findBundledCaddyBinary: typeof import('../../services/caddy/caddyProxy.js').findBundledCaddyBinary;
let _resetBundledCaddyBinaryCacheForTests: typeof import('../../services/caddy/caddyProxy.js')._resetBundledCaddyBinaryCacheForTests;

beforeAll(async () => {
  const mod = await import('../../services/caddy/caddyProxy.js');
  CaddyProxyManager = mod.CaddyProxyManager;
  resolveDialAddress = mod.resolveDialAddress;
  buildCaddyConfig = mod.buildCaddyConfig;
  buildPatchBody = mod.buildPatchBody;
  findFreePort = mod.findFreePort;
  CADDY_HANDLER_ID = mod.CADDY_HANDLER_ID;
  CaddyBinaryNotFoundError = mod.CaddyBinaryNotFoundError;
  CaddyStartupError = mod.CaddyStartupError;
  CaddyAdminApiError = mod.CaddyAdminApiError;
  CaddyPortReclaimError = mod.CaddyPortReclaimError;
  sweepOrphanedConfigs = mod.sweepOrphanedConfigs;
  _resetOrphanSweepForTests = mod._resetOrphanSweepForTests;
  findBundledCaddyBinary = mod.findBundledCaddyBinary;
  _resetBundledCaddyBinaryCacheForTests = mod._resetBundledCaddyBinaryCacheForTests;
});

// ── Fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  jest.clearAllMocks();
  spawnedChildren = [];
  httpCalls = [];
  spawnImpl = () => {
    const child = new FakeChildProcess();
    spawnedChildren.push(child);
    return child;
  };
  httpHandler = () => ({ kind: 'response', status: 200, body: '' });
  tmpDir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'caddyProxyTest-'));
});

afterEach(() => {
  fsReal.rmSync(tmpDir, { recursive: true, force: true });
});

function makeManager(overrides: Record<string, unknown> = {}) {
  return new CaddyProxyManager({
    configDir: tmpDir,
    caddyBinOverride: 'fake-caddy',
    startTimeoutMs: 500,
    probeIntervalMs: 5,
    ...overrides,
  });
}

// ── Pure logic: resolveDialAddress() ────────────────────────────────────────

describe('resolveDialAddress — HTTP/Docker upstream matrix', () => {
  test('http, non-docker → 127.0.0.1:port', () => {
    expect(resolveDialAddress(3000, false, false)).toBe('127.0.0.1:3000');
  });

  test('http, docker → host.docker.internal:port', () => {
    expect(resolveDialAddress(3000, false, true)).toBe('host.docker.internal:3000');
  });

  test('https, non-docker → localhost:port (NOT 127.0.0.1 — regression guard, preserved verbatim from tunnelManager.ts:698)', () => {
    expect(resolveDialAddress(3000, true, false)).toBe('localhost:3000');
  });

  test('https, docker → host.docker.internal:port', () => {
    expect(resolveDialAddress(3000, true, true)).toBe('host.docker.internal:3000');
  });
});

// ── Pure logic: buildPatchBody() Docker+HTTPS matrix ───────────────────────

describe('buildPatchBody — exact PATCH body per {isHttpsLocal, inDocker} combination', () => {
  test('http, non-docker: no transport key, plain loopback dial', () => {
    expect(buildPatchBody({ port: 3000 }, false)).toEqual({
      '@id': CADDY_HANDLER_ID,
      handler: 'reverse_proxy',
      upstreams: [{ dial: '127.0.0.1:3000' }],
    });
  });

  test('http, docker: no transport key, dockerHost dial', () => {
    expect(buildPatchBody({ port: 3000, isHttpsLocal: false }, true)).toEqual({
      '@id': CADDY_HANDLER_ID,
      handler: 'reverse_proxy',
      upstreams: [{ dial: 'host.docker.internal:3000' }],
    });
  });

  test('https, non-docker: transport present, localhost dial', () => {
    expect(buildPatchBody({ port: 3000, isHttpsLocal: true }, false)).toEqual({
      '@id': CADDY_HANDLER_ID,
      handler: 'reverse_proxy',
      upstreams: [{ dial: 'localhost:3000' }],
      transport: { protocol: 'http', tls: { insecure_skip_verify: true } },
    });
  });

  test('https, docker: transport present, dockerHost dial', () => {
    expect(buildPatchBody({ port: 3000, isHttpsLocal: true }, true)).toEqual({
      '@id': CADDY_HANDLER_ID,
      handler: 'reverse_proxy',
      upstreams: [{ dial: 'host.docker.internal:3000' }],
      transport: { protocol: 'http', tls: { insecure_skip_verify: true } },
    });
  });

  test('never emits a header_up directive (Host hold-the-line contract)', () => {
    const body = buildPatchBody({ port: 3000, isHttpsLocal: true }, false);
    expect(JSON.stringify(body)).not.toMatch(/header_up/i);
  });
});

// ── Pure logic: buildCaddyConfig() ──────────────────────────────────────────

describe('buildCaddyConfig', () => {
  test('binds both admin and proxy listeners to 127.0.0.1 only', () => {
    const cfg = buildCaddyConfig(19000, 19001);
    expect(cfg.admin.listen).toBe('127.0.0.1:19001');
    expect(cfg.apps.http.servers.srv0.listen).toEqual(['127.0.0.1:19000']);
  });

  test('tags the reverse_proxy handler with @id: dbg-handler', () => {
    const cfg = buildCaddyConfig(19000, 19001);
    const handler = cfg.apps.http.servers.srv0.routes[0].handle[0] as Record<string, unknown>;
    expect(handler['@id']).toBe(CADDY_HANDLER_ID);
    expect(handler.handler).toBe('reverse_proxy');
  });

  test('produces valid, round-trippable JSON', () => {
    const cfg = buildCaddyConfig(19000, 19001);
    expect(() => JSON.parse(JSON.stringify(cfg))).not.toThrow();
  });

  test('no header_up Host directive present anywhere in the generated config', () => {
    const cfg = buildCaddyConfig(19000, 19001);
    const json = JSON.stringify(cfg);
    expect(json).not.toMatch(/header_up/i);
  });
});

// ── findFreePort() ──────────────────────────────────────────────────────────

describe('findFreePort', () => {
  test('returns distinct ports on sequential calls', async () => {
    const a = await findFreePort();
    const b = await findFreePort();
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

// ── findBundledCaddyBinary (the @radically-straightforward/caddy fallback tier) ──
//
// Deliberately NOT mocking fs/path/url here (this file's existing convention —
// see sweepOrphanedConfigs below — already exercises real fs against a real
// project tree). This function's whole job is finding a REAL file relative to
// the REAL package root, so testing it against the actual installed
// node_modules/.bin/caddy is more honest than mocking the filesystem it's
// meant to walk: a mock could pass while the real npm-install-time contract
// (this repo depends on @radically-straightforward/caddy, which drops the
// binary there) silently drifts.

describe('findBundledCaddyBinary', () => {
  afterEach(() => {
    _resetBundledCaddyBinaryCacheForTests();
  });

  maybeTest('finds the real binary installed by @radically-straightforward/caddy at node_modules/.bin/caddy', () => {
    const found = findBundledCaddyBinary();
    expect(found).toBeDefined();
    expect(pathReal.basename(found!)).toBe(process.platform === 'win32' ? 'caddy.exe' : 'caddy');
    expect(fsReal.existsSync(found!)).toBe(true);
  });

  maybeTest('memoizes: repeated calls return the identical string without re-walking', () => {
    const first = findBundledCaddyBinary();
    const second = findBundledCaddyBinary();
    expect(second).toBe(first);
  });

  maybeTest('_resetBundledCaddyBinaryCacheForTests() forces a fresh resolve that still finds the same real binary', () => {
    const before = findBundledCaddyBinary();
    _resetBundledCaddyBinaryCacheForTests();
    const after = findBundledCaddyBinary();
    expect(after).toBe(before);
  });

  maybeTest('resolveCaddyBinary precedence: with no CADDY_BIN and no caddyBinOverride, ensureStarted() spawns the bundled binary — not a bare "caddy" PATH lookup', async () => {
    delete process.env.CADDY_BIN;
    const manager = new CaddyProxyManager({ configDir: tmpDir, startTimeoutMs: 500, probeIntervalMs: 5 });
    httpHandler = () => ({ kind: 'response', status: 200, body: '' });
    await manager.ensureStarted();
    expect(mockSpawn).toHaveBeenCalledWith(findBundledCaddyBinary(), expect.anything(), expect.anything());
  });

  maybeTestNoBundledBinary('when the bundled binary is absent (e.g. npm ci --ignore-scripts), resolveCaddyBinary falls through to a bare "caddy" PATH lookup', async () => {
    delete process.env.CADDY_BIN;
    const manager = new CaddyProxyManager({ configDir: tmpDir, startTimeoutMs: 500, probeIntervalMs: 5 });
    httpHandler = () => ({ kind: 'response', status: 200, body: '' });
    await manager.ensureStarted();
    expect(mockSpawn).toHaveBeenCalledWith('caddy', expect.anything(), expect.anything());
  });

  test('resolveCaddyBinary precedence: CADDY_BIN env still wins over the bundled binary', async () => {
    process.env.CADDY_BIN = '/explicit/env/caddy';
    try {
      const manager = new CaddyProxyManager({ configDir: tmpDir, startTimeoutMs: 500, probeIntervalMs: 5 });
      httpHandler = () => ({ kind: 'response', status: 200, body: '' });
      await manager.ensureStarted();
      expect(mockSpawn).toHaveBeenCalledWith('/explicit/env/caddy', expect.anything(), expect.anything());
    } finally {
      delete process.env.CADDY_BIN;
    }
  });
});

// ── sweepOrphanedConfigs (startup orphan sweep) ─────────────────────────────

describe('sweepOrphanedConfigs', () => {
  test('removes config files whose PID is dead, keeps files whose PID is alive', () => {
    _resetOrphanSweepForTests();
    const deadPid = 999999; // exceedingly unlikely to be a live PID
    const alivePid = process.pid;
    const deadFile = `config-${deadPid}-${'a'.repeat(12)}.json`;
    const aliveFile = `config-${alivePid}-${'b'.repeat(12)}.json`;
    fsReal.writeFileSync(pathReal.join(tmpDir, deadFile), '{}');
    fsReal.writeFileSync(pathReal.join(tmpDir, aliveFile), '{}');

    sweepOrphanedConfigs(tmpDir);

    const remaining = fsReal.readdirSync(tmpDir);
    expect(remaining).toContain(aliveFile);
    expect(remaining).not.toContain(deadFile);
  });

  test('regression guard: real generated config filenames match the sweep regex', async () => {
    _resetOrphanSweepForTests();
    const mgr = makeManager();
    await mgr.ensureStarted();
    const files = fsReal.readdirSync(tmpDir);
    expect(files.length).toBe(1);

    // Re-running the sweep against this process's OWN live pid must never
    // remove its own still-in-use config file (proves the filename this
    // manager actually writes is recognized — not silently ignored — by
    // CONFIG_FILE_RE).
    _resetOrphanSweepForTests();
    sweepOrphanedConfigs(tmpDir);
    expect(fsReal.readdirSync(tmpDir)).toEqual(files);

    await mgr.stop();
  });

  test('only runs once per process (module-level guard) until reset', () => {
    _resetOrphanSweepForTests();
    const deadFile = `config-999999-${'c'.repeat(12)}.json`;
    fsReal.writeFileSync(pathReal.join(tmpDir, deadFile), '{}');
    sweepOrphanedConfigs(tmpDir); // sweeps it away, sets the guard
    expect(fsReal.readdirSync(tmpDir)).not.toContain(deadFile);

    fsReal.writeFileSync(pathReal.join(tmpDir, deadFile), '{}');
    sweepOrphanedConfigs(tmpDir); // guard already tripped — no-op this call
    expect(fsReal.readdirSync(tmpDir)).toContain(deadFile);
  });
});

// ── Lifecycle: ensureStarted() ───────────────────────────────────────────────

describe('ensureStarted()', () => {
  test('spawns exactly once for N concurrent callers', async () => {
    const mgr = makeManager();
    const [a, b, c] = await Promise.all([mgr.ensureStarted(), mgr.ensureStarted(), mgr.ensureStarted()]);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test('resolves only after the health probe returns 200', async () => {
    let getCalls = 0;
    const readyAfter = 3;
    httpHandler = (options) => {
      if (options.method === 'GET') {
        getCalls++;
        return getCalls >= readyAfter ? { kind: 'response', status: 200 } : { kind: 'response', status: 503 };
      }
      return { kind: 'response', status: 200 };
    };
    const mgr = makeManager();
    const handle = await mgr.ensureStarted();
    expect(getCalls).toBeGreaterThanOrEqual(readyAfter);
    expect(handle.adminPort).toBeGreaterThan(0);
    expect(handle.localOrigin).toBe(`http://127.0.0.1:${handle.localPort}`);
  });

  test('rejects CaddyBinaryNotFoundError on ENOENT (fails fast, no retry)', async () => {
    spawnImpl = () => {
      const child = new FakeChildProcess();
      spawnedChildren.push(child);
      queueMicrotask(() => {
        const err = Object.assign(new Error('spawn fake-caddy ENOENT'), { code: 'ENOENT' });
        child.emit('error', err);
      });
      return child;
    };
    const mgr = makeManager();
    await expect(mgr.ensureStarted()).rejects.toBeInstanceOf(CaddyBinaryNotFoundError);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  test('retries once with a fresh port after an early crash, succeeds on attempt 2', async () => {
    let attempt = 0;
    spawnImpl = () => {
      attempt++;
      const child = new FakeChildProcess();
      spawnedChildren.push(child);
      if (attempt === 1) {
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
      }
      return child;
    };
    const mgr = makeManager();
    const handle = await mgr.ensureStarted();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(handle.localPort).toBeGreaterThan(0);
  });

  test('throws CaddyStartupError (not CaddyPortReclaimError) after both attempts crash on a fresh manager', async () => {
    spawnImpl = () => {
      const child = new FakeChildProcess();
      spawnedChildren.push(child);
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
      return child;
    };
    const mgr = makeManager();
    let caught: unknown;
    try {
      await mgr.ensureStarted();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CaddyStartupError);
    expect(caught).not.toBeInstanceOf(CaddyPortReclaimError);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  test('respawn reuses the sticky proxy port', async () => {
    const mgr = makeManager();
    const first = await mgr.ensureStarted();

    spawnedChildren[0].exitCode = 1;
    spawnedChildren[0].emit('exit', 1, null);
    await Promise.resolve();

    const second = await mgr.ensureStarted();
    expect(second.localPort).toBe(first.localPort);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  test('respawn where the sticky port fails but a fresh port succeeds fires onPortChanged and does NOT throw', async () => {
    const mgr = makeManager();
    const first = await mgr.ensureStarted();
    const portChangedSpy = jest.fn();
    mgr.onPortChanged(portChangedSpy);

    spawnedChildren[0].exitCode = 1;
    spawnedChildren[0].emit('exit', 1, null);
    await Promise.resolve();

    let respawnAttempt = 0;
    spawnImpl = () => {
      respawnAttempt++;
      const child = new FakeChildProcess();
      spawnedChildren.push(child);
      if (respawnAttempt === 1) {
        // sticky-port reclaim attempt fails
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
      }
      return child; // attempt 2 (fresh port) succeeds
    };

    const second = await mgr.ensureStarted();
    expect(second.localPort).not.toBe(first.localPort);
    expect(mockSpawn).toHaveBeenCalledTimes(3); // 1 initial + 2 respawn attempts
    expect(portChangedSpy).toHaveBeenCalledTimes(1);
    expect(portChangedSpy).toHaveBeenCalledWith(`http://127.0.0.1:${second.localPort}`);
  });

  test('respawn where BOTH attempts fail throws CaddyPortReclaimError specifically', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();

    spawnedChildren[0].exitCode = 1;
    spawnedChildren[0].emit('exit', 1, null);
    await Promise.resolve();

    spawnImpl = () => {
      const child = new FakeChildProcess();
      spawnedChildren.push(child);
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
      return child;
    };

    await expect(mgr.ensureStarted()).rejects.toBeInstanceOf(CaddyPortReclaimError);
  });
});

// ── Lifecycle: setUpstream() ─────────────────────────────────────────────────

describe('setUpstream()', () => {
  test('LIFE-4: every PATCH body includes @id, not just the first (the resend trap)', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();
    await mgr.setUpstream({ port: 3000 });
    await mgr.setUpstream({ port: 4000 });

    const patches = httpCalls.filter((c) => c.method === 'PATCH');
    expect(patches.length).toBe(2);
    for (const call of patches) {
      const body = JSON.parse(call.body!);
      expect(body['@id']).toBe(CADDY_HANDLER_ID);
    }
  });

  test('idempotent: an unchanged target issues zero additional PATCH calls', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();
    await mgr.setUpstream({ port: 3000, isHttpsLocal: false });
    const afterFirst = httpCalls.filter((c) => c.method === 'PATCH').length;

    await mgr.setUpstream({ port: 3000, isHttpsLocal: false });
    const afterSecond = httpCalls.filter((c) => c.method === 'PATCH').length;

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(afterFirst);
  });

  test('same port + flipped isHttpsLocal issues a new PATCH (not masked by port-only comparison)', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();
    await mgr.setUpstream({ port: 3000, isHttpsLocal: false });
    await mgr.setUpstream({ port: 3000, isHttpsLocal: true });

    const patches = httpCalls.filter((c) => c.method === 'PATCH');
    expect(patches.length).toBe(2);
    const secondBody = JSON.parse(patches[1].body!);
    expect(secondBody.transport).toEqual({ protocol: 'http', tls: { insecure_skip_verify: true } });
  });

  test('throws CaddyAdminApiError (no respawn) when the process is alive but the admin API 4xx/5xxs', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();
    httpHandler = (options) => {
      if (options.method === 'PATCH') return { kind: 'response', status: 500, body: 'boom' };
      return { kind: 'response', status: 200 };
    };
    await expect(mgr.setUpstream({ port: 3000 })).rejects.toBeInstanceOf(CaddyAdminApiError);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  test('triggers exactly one respawn+retry when the admin API is unreachable (process confirmed dead)', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();

    let patchCalls = 0;
    httpHandler = (options) => {
      if (options.method === 'PATCH') {
        patchCalls++;
        if (patchCalls === 1) {
          const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' });
          return { kind: 'error', error: err };
        }
        return { kind: 'response', status: 200 };
      }
      return { kind: 'response', status: 200 }; // GET readiness probe always healthy
    };

    await mgr.setUpstream({ port: 3000 });
    expect(patchCalls).toBe(2);
    expect(mockSpawn).toHaveBeenCalledTimes(2); // original + one respawn
  });

  test('bounded: propagates uncaught if the retry after respawn also fails (no loop)', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();

    let patchCalls = 0;
    httpHandler = (options) => {
      if (options.method === 'PATCH') {
        patchCalls++;
        const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return { kind: 'error', error: err };
      }
      return { kind: 'response', status: 200 };
    };

    await expect(mgr.setUpstream({ port: 3000 })).rejects.toThrow();
    expect(patchCalls).toBe(2); // exactly one retry — not a loop
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

// ── Lifecycle: stop() ─────────────────────────────────────────────────────

describe('stop()', () => {
  test('kills the child and removes the config file', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();
    const child = spawnedChildren[0];
    expect(fsReal.readdirSync(tmpDir).length).toBe(1);

    await mgr.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(fsReal.readdirSync(tmpDir).length).toBe(0);
  });

  test('is idempotent', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();
    await mgr.stop();
    await expect(mgr.stop()).resolves.toBeUndefined();
  });

  test('is a safe no-op if never started', async () => {
    const mgr = makeManager();
    await expect(mgr.stop()).resolves.toBeUndefined();
  });
});

// ── isHealthy() ──────────────────────────────────────────────────────────────

describe('isHealthy()', () => {
  test('never throws; false before start', async () => {
    const mgr = makeManager();
    await expect(mgr.isHealthy()).resolves.toBe(false);
  });

  test('true once started and the probe returns 200', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();
    await expect(mgr.isHealthy()).resolves.toBe(true);
  });

  test('false (not throw) if the probe errors', async () => {
    const mgr = makeManager();
    await mgr.ensureStarted();
    httpHandler = () => ({ kind: 'error', error: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    await expect(mgr.isHealthy()).resolves.toBe(false);
  });
});
