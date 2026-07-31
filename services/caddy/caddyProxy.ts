/**
 * Caddy proxy service — services/caddy/caddyProxy.ts
 *
 * One CaddyProxyManager instance per session key (§2.1/§2.2 of
 * docs/local-tunnel-multiplexer-architecture-2026-07-31.md). Spawns a local
 * `caddy` process holding EXACTLY ONE dynamic reverse-proxy upstream, bound
 * to loopback only, repointed via Caddy's local (unauthenticated) admin API
 * immediately before each tool dispatch that needs a different local port.
 *
 * This is the structural fix for the Feb 2026 path-prefix-routing bug
 * (beads lb8/p6y/brl/vp9): there is no `/p/{port}` prefix, no path
 * rewriting at all, so root-absolute requests (`/api/...`, `/_next/...`)
 * never collide with a second port "in the way."
 *
 * See the architecture doc §2.2 for the full design rationale — this file
 * is a direct implementation of it, not a reinterpretation.
 */

// NOTE: child_process/http are imported WITHOUT the 'node:' prefix
// deliberately — jest's unstable_mockModule (ESM mocking) cannot reliably
// intercept 'node:'-prefixed builtin specifiers in this repo's jest/ts-jest
// setup, but it can intercept the bare form (matches utils/gitContext.ts's
// existing 'child_process' mock convention). Mocked in
// __tests__/services/caddyProxy.test.ts.
import { spawn, type ChildProcess } from 'child_process';
import * as http from 'http';
import { createServer } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Logger } from '../../utils/logger.js';

const logger = new Logger({ module: 'caddyProxy' });

// ── Public types ────────────────────────────────────────────────────────────

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
   *  the whole session tunnel. See CaddyPortReclaimError and the doc's §6. */
  onPortChanged(cb: (newLocalOrigin: string) => void): void;
}

// ── Error classes (house style: named subclasses of Error, see
//    services/tunnels.ts's TunnelProvisionError for the pattern) ───────────

export class CaddyBinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaddyBinaryNotFoundError';
  }
}

export class CaddyStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaddyStartupError';
  }
}

export class CaddyAdminApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaddyAdminApiError';
  }
}

export class CaddyPortReclaimError extends CaddyStartupError {
  constructor(message: string) {
    super(message);
    this.name = 'CaddyPortReclaimError';
  }
}

// ── Pure logic: HTTP/Docker upstream matrix ─────────────────────────────────

/**
 * Caddy owns the full isHttpsLocal/inDocker/dockerHost resolution internally
 * (architecture doc §2.2), reading `inDocker` exactly as
 * tunnelManager.ts:688 does today (`process.env.DOCKER_CONTAINER === 'true'`).
 * Callers pass only `{port, isHttpsLocal}` — the one fact Caddy cannot derive.
 *
 * The `localhost` (NOT `127.0.0.1`) asymmetry on the HTTPS/non-Docker branch
 * is preserved verbatim from tunnelManager.ts:698, per explicit brief in the
 * architecture doc — do not "fix" this to 127.0.0.1.
 */
export function resolveDialAddress(port: number, isHttpsLocal: boolean, inDocker: boolean): string {
  const dockerHost = 'host.docker.internal';
  if (isHttpsLocal) return inDocker ? `${dockerHost}:${port}` : `localhost:${port}`; // NOT 127.0.0.1 — preserved verbatim
  return inDocker ? `${dockerHost}:${port}` : `127.0.0.1:${port}`;
}

/** Whether the current process is running inside Docker, per DOCKER_CONTAINER env var. */
export function isDockerEnv(): boolean {
  return process.env.DOCKER_CONTAINER === 'true';
}

// ── Bundled binary resolution ────────────────────────────────────────────────
//
// @radically-straightforward/caddy is a dependency (package.json's "caddy"
// field pins the exact version — see its postinstall) that downloads Caddy
// from the project's own GitHub releases and drops it at
// node_modules/.bin/caddy(.exe). Same pattern this repo already uses for the
// ngrok binary (the "ngrok" npm package's own postinstall). Pinned rather
// than "latest" deliberately: a real config incompatibility with a Caddy
// version (--adapter json rejected by 2.11.3) was found and fixed during
// development of this file — "latest" silently shipping a breaking change
// under us is exactly the failure mode pinning avoids.
//
// Precedence (resolveCaddyBinary): CADDY_BIN env → caddyBinOverride ctor opt
// → this bundled binary → bare 'caddy' resolved from PATH (last resort, e.g.
// a system install with no bundled binary present for some reason).

let _bundledCaddyBinaryCache: string | null | undefined; // undefined = not yet resolved

/** Same "walk up to my own package.json" pattern as config/index.ts's
 *  findPackageVersion() — finds this package's root regardless of whether
 *  it's a repo checkout, a global install, or an npx cache dir. */
function findOwnPackageRoot(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      if (pkg.name === '@debugg-ai/debugg-ai-mcp') return dir;
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Resolves (and caches) the path to the bundled Caddy binary, if present.
 *  Returns undefined if @radically-straightforward/caddy's postinstall never
 *  ran or failed (e.g. npm install --ignore-scripts) — resolveCaddyBinary()
 *  falls through to a bare 'caddy' PATH lookup in that case. */
export function findBundledCaddyBinary(): string | undefined {
  if (_bundledCaddyBinaryCache !== undefined) return _bundledCaddyBinaryCache ?? undefined;
  const root = findOwnPackageRoot();
  if (!root) {
    _bundledCaddyBinaryCache = null;
    return undefined;
  }
  const binName = process.platform === 'win32' ? 'caddy.exe' : 'caddy';
  const binPath = path.join(root, 'node_modules', '.bin', binName);
  _bundledCaddyBinaryCache = fs.existsSync(binPath) ? binPath : null;
  return _bundledCaddyBinaryCache ?? undefined;
}

/** Test-only: clears the memoized bundled-binary lookup. */
export function _resetBundledCaddyBinaryCacheForTests(): void {
  _bundledCaddyBinaryCache = undefined;
}

// ── Config file location ─────────────────────────────────────────────────────

/** ~/.debugg-ai/caddy — config files live here, one per (pid, instanceId). */
export function caddyConfigDir(): string {
  return path.join(os.homedir(), '.debugg-ai', 'caddy');
}

const CONFIG_FILE_RE = /^config-(\d+)-[a-f0-9]+\.json$/;

function configFileName(pid: number, instanceId: string): string {
  return `config-${pid}-${instanceId}.json`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but we lack permission to signal it —
    // still alive. Anything else (ESRCH etc.) means it's gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Startup orphan sweep: removes config files left behind by processes that
 * are no longer alive. Runs once per MCP process lifetime (module-level
 * guard) — cheap, but pointless to repeat per session-key instance.
 */
let orphanSweepDone = false;
export function sweepOrphanedConfigs(dir: string = caddyConfigDir()): void {
  if (orphanSweepDone) return;
  orphanSweepDone = true;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // directory doesn't exist yet — nothing to sweep
  }
  for (const name of entries) {
    const m = CONFIG_FILE_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    if (!isPidAlive(pid)) {
      try {
        fs.unlinkSync(path.join(dir, name));
        logger.debug(`Swept orphaned Caddy config file: ${name}`);
      } catch (err) {
        logger.debug(`Failed to remove orphaned Caddy config file ${name}: ${err}`);
      }
    }
  }
}

/** Test-only: allow re-running the sweep within one process. */
export function _resetOrphanSweepForTests(): void {
  orphanSweepDone = false;
}

// ── findFreePort() — bind :0 and close ──────────────────────────────────────

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        srv.close((closeErr) => {
          if (closeErr) reject(closeErr);
          else resolve(port);
        });
      } else {
        srv.close(() => reject(new Error('findFreePort: could not determine bound port')));
      }
    });
  });
}

// ── Config builder ────────────────────────────────────────────────────────

/** The single addressable handler node every PATCH targets: GET/PATCH /id/dbg-handler. */
export const CADDY_HANDLER_ID = 'dbg-handler';

/** Placeholder upstream: dials a closed port so a stray request 502s cleanly
 *  from the first millisecond instead of exposing a raw connection-refused. */
const PLACEHOLDER_DIAL = '127.0.0.1:1';

export interface CaddyConfig {
  admin: { listen: string };
  apps: {
    http: {
      servers: {
        srv0: {
          listen: string[];
          routes: Array<{
            handle: Array<Record<string, unknown>>;
          }>;
        };
      };
    };
  };
}

/**
 * Builds the eager-at-spawn Caddy JSON config. One code path for every call
 * including the first (architecture doc §2.2): PATCH-only against a known
 * @id-tagged node so config-shape drift 400s loudly instead of silently
 * building new structure. Both listeners bind 127.0.0.1 only — the admin
 * API has no built-in auth, so this is a hard security requirement.
 */
export function buildCaddyConfig(proxyPort: number, adminPort: number): CaddyConfig {
  return {
    admin: { listen: `127.0.0.1:${adminPort}` },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [`127.0.0.1:${proxyPort}`],
            routes: [
              {
                handle: [
                  {
                    '@id': CADDY_HANDLER_ID,
                    handler: 'reverse_proxy',
                    // DO NOT add header_up Host — see
                    // docs/local-tunnel-multiplexer-architecture-2026-07-31.md §2.2;
                    // this would change what every local dev server sees vs. today.
                    upstreams: [{ dial: PLACEHOLDER_DIAL }],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

/**
 * Builds the PATCH body for a real upstream target. One PATCH atomically
 * replaces both `dial` and `transport` — never two separate requests — so
 * Caddy is never briefly holding a mismatched dial/transport pair. `@id`
 * MUST be resent in every PATCH body: PATCH replaces the value at that
 * address, so an omitted `@id` deletes the tag and the NEXT PATCH 404s
 * (only manifests on the second call — see LIFE-4 in the test suite).
 */
export function buildPatchBody(target: UpstreamTarget, inDocker: boolean): Record<string, unknown> {
  const isHttpsLocal = !!target.isHttpsLocal;
  const dial = resolveDialAddress(target.port, isHttpsLocal, inDocker);
  const body: Record<string, unknown> = {
    '@id': CADDY_HANDLER_ID,
    handler: 'reverse_proxy',
    upstreams: [{ dial }],
  };
  if (isHttpsLocal) {
    // Local self-signed certs — doesn't touch the public leg's real ngrok TLS.
    body.transport = { protocol: 'http', tls: { insecure_skip_verify: true } };
  }
  return body;
}

// ── Small HTTP helper (admin API + readiness probe) ─────────────────────────

interface HttpResult {
  status: number;
  body: string;
}

function adminHttpRequest(
  adminPort: number,
  method: string,
  reqPath: string,
  body?: string,
  timeoutMs = 2000,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: adminPort,
        path: reqPath,
        method,
        headers: body != null
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`admin API request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function probeAdminHealthy(adminPort: number): Promise<boolean> {
  try {
    const res = await adminHttpRequest(adminPort, 'GET', `/id/${CADDY_HANDLER_ID}`, undefined, 500);
    return res.status === 200;
  } catch {
    return false;
  }
}

// ── CaddyProxyManager ────────────────────────────────────────────────────────

export interface CaddyProxyManagerOptions {
  /** CADDY_BIN env var → caddyBinOverride → bundled binary (node_modules/.bin/caddy,
   *  installed by the @radically-straightforward/caddy dependency) → bare 'caddy' on PATH. */
  caddyBinOverride?: string;
  /** Readiness-probe cap. Default 5000ms per the architecture doc §2.2. */
  startTimeoutMs?: number;
  /** Readiness-probe poll interval. Default 100ms per the architecture doc §2.2. */
  probeIntervalMs?: number;
  configDir?: string;
}

export class CaddyProxyManager implements CaddyProxy {
  private readonly instanceId: string;
  private readonly configDir: string;
  private readonly startTimeoutMs: number;
  private readonly probeIntervalMs: number;
  private readonly caddyBinOverride?: string;

  private child: ChildProcess | null = null;
  private proxyPort: number | null = null;
  private adminPort: number | null = null;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private configPath: string | null = null;

  private lastProxyPort: number | null = null;
  private lastAppliedTarget: { port: number; isHttpsLocal: boolean } | null = null;

  private readonly portChangedListeners: Array<(newLocalOrigin: string) => void> = [];

  constructor(opts: CaddyProxyManagerOptions = {}) {
    // Short random hex suffix — PID alone collides once one process hosts
    // multiple session keys (HTTP mode). Must stay pure lowercase-hex: it's
    // matched by CONFIG_FILE_RE during the orphan sweep below.
    this.instanceId = randomBytes(6).toString('hex');
    this.configDir = opts.configDir ?? caddyConfigDir();
    this.startTimeoutMs = opts.startTimeoutMs ?? 5000;
    this.probeIntervalMs = opts.probeIntervalMs ?? 100;
    this.caddyBinOverride = opts.caddyBinOverride;
  }

  // -- CaddyProxy interface -------------------------------------------------

  async ensureStarted(): Promise<{ localOrigin: string; localPort: number; adminPort: number }> {
    if (this.started && this.child && !this.isChildDead) {
      return this.currentHandle();
    }
    if (this.startPromise) {
      await this.startPromise;
      return this.currentHandle();
    }
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
    return this.currentHandle();
  }

  async setUpstream(target: UpstreamTarget): Promise<void> {
    const { adminPort } = await this.ensureStarted();
    const isHttpsLocal = !!target.isHttpsLocal;

    if (
      this.lastAppliedTarget &&
      this.lastAppliedTarget.port === target.port &&
      this.lastAppliedTarget.isHttpsLocal === isHttpsLocal
    ) {
      return; // idempotent no-op — this is what makes same-port calls free
    }

    const body = buildPatchBody(target, isDockerEnv());

    try {
      await this.patchHandler(adminPort, body);
    } catch (err) {
      if (err instanceof CaddyAdminApiError) {
        // Process is alive but the admin API rejected the PATCH — no respawn,
        // propagate as-is.
        throw err;
      }
      // Network-level failure against a previously-healthy admin port —
      // the process is presumed dead. Exactly one respawn-and-retry, then
      // propagate uncaught — no loop (matches ngrokAgentSession.ts's
      // onTerminated philosophy: lazy, bounded, next-call-triggered).
      logger.warn(`Caddy admin API unreachable on port ${adminPort} — assuming process died, respawning once: ${err}`);
      this.markDead();
      const { adminPort: freshAdminPort } = await this.ensureStarted();
      await this.patchHandler(freshAdminPort, body);
    }

    this.lastAppliedTarget = { port: target.port, isHttpsLocal };
  }

  async isHealthy(): Promise<boolean> {
    if (!this.started || !this.adminPort || this.isChildDead) return false;
    try {
      return await probeAdminHealthy(this.adminPort);
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.started = false;
    this.child = null;
    this.proxyPort = null;
    this.adminPort = null;
    this.lastAppliedTarget = null;

    if (child && !this.isChildDeadRef(child)) {
      try {
        child.kill();
      } catch (err) {
        logger.debug(`caddy.stop(): kill() failed (already dead?): ${err}`);
      }
    }

    if (this.configPath) {
      try {
        fs.unlinkSync(this.configPath);
      } catch {
        // best effort — file may already be gone
      }
      this.configPath = null;
    }
  }

  onPortChanged(cb: (newLocalOrigin: string) => void): void {
    this.portChangedListeners.push(cb);
  }

  // -- internals --------------------------------------------------------------

  private get isChildDead(): boolean {
    return this.child ? this.isChildDeadRef(this.child) : true;
  }

  private isChildDeadRef(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  private markDead(): void {
    this.started = false;
    this.child = null;
  }

  private currentHandle(): { localOrigin: string; localPort: number; adminPort: number } {
    if (!this.started || this.proxyPort == null || this.adminPort == null) {
      throw new CaddyStartupError('CaddyProxyManager: not started (internal invariant violation)');
    }
    return {
      localOrigin: `http://127.0.0.1:${this.proxyPort}`,
      localPort: this.proxyPort,
      adminPort: this.adminPort,
    };
  }

  private resolveCaddyBinary(): string {
    return process.env.CADDY_BIN || this.caddyBinOverride || findBundledCaddyBinary() || 'caddy';
  }

  private writeConfig(proxyPort: number, adminPort: number): string {
    fs.mkdirSync(this.configDir, { recursive: true });
    const configPath = path.join(this.configDir, configFileName(process.pid, this.instanceId));
    const config = buildCaddyConfig(proxyPort, adminPort);
    fs.writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  }

  private async patchHandler(adminPort: number, body: Record<string, unknown>): Promise<void> {
    const json = JSON.stringify(body);
    const res = await adminHttpRequest(adminPort, 'PATCH', `/id/${CADDY_HANDLER_ID}`, json);
    if (res.status < 200 || res.status >= 300) {
      throw new CaddyAdminApiError(`PATCH /id/${CADDY_HANDLER_ID} failed: ${res.status} ${res.body}`);
    }
  }

  /**
   * Waits for the admin API's readiness probe (GET /id/dbg-handler, every
   * `probeIntervalMs`, capped at `startTimeoutMs`) racing the child's own
   * `exit`/`error` events — an early crash or a missing binary must fail
   * fast, not wait out the full timeout.
   */
  private waitForHealthy(adminPort: number, child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      // `interval` is referenced inside `finish` below before its own `const`
      // declaration further down this block — safe because `finish` is only
      // ever CALLED from an async event, by which point `interval` has
      // already been assigned (closures resolve free variables at call
      // time, not at definition time).
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        child.off('exit', onExit);
        child.off('error', onError);
        fn();
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(() => reject(new CaddyStartupError(`caddy process exited during startup (code=${code}, signal=${signal})`)));
      };

      const onError = (err: NodeJS.ErrnoException) => {
        finish(() => {
          if (err.code === 'ENOENT') {
            reject(new CaddyBinaryNotFoundError(
              `caddy binary not found (tried "${this.resolveCaddyBinary()}"). This should have been ` +
              `installed automatically by the @radically-straightforward/caddy dependency — if you ran ` +
              `npm install with --ignore-scripts, or in an offline/air-gapped environment, that download ` +
              `never ran. Fix by either installing caddy yourself ("brew install caddy" on macOS, ` +
              `"apt install caddy" on Debian/Ubuntu, or see https://caddyserver.com/docs/install) and ` +
              `pointing CADDY_BIN at it, or re-running npm install with scripts enabled.`,
            ));
          } else {
            reject(new CaddyStartupError(String(err)));
          }
        });
      };

      child.once('exit', onExit);
      child.once('error', onError);

      const deadline = Date.now() + this.startTimeoutMs;
      const check = async () => {
        if (settled) return;
        const ok = await probeAdminHealthy(adminPort);
        if (ok) {
          finish(resolve);
          return;
        }
        if (Date.now() >= deadline) {
          finish(() => reject(new CaddyStartupError(`caddy admin API did not become healthy within ${this.startTimeoutMs}ms`)));
        }
      };
      const interval = setInterval(check, this.probeIntervalMs);
      check();
    });
  }

  /**
   * Sticky proxy port across crash-respawn: attempt 1 reuses the last
   * successfully-bound proxy port (if any); attempt 2 falls back to a fresh
   * one. `CaddyPortReclaimError` means BOTH attempts failed — Caddy is fully
   * down. `onPortChanged` fires on the "succeeded but moved" case, which is
   * the signal TunnelManager needs to evict the now-orphaned ngrok tunnel.
   */
  private async doStart(): Promise<void> {
    sweepOrphanedConfigs(this.configDir);

    const bin = this.resolveCaddyBinary();
    let stickyAttemptFailed = false;
    const priorProxyPort = this.lastProxyPort;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const useSticky = attempt === 1 && priorProxyPort != null;
      const proxyPort = useSticky ? priorProxyPort! : await findFreePort();
      const adminPort = await findFreePort();
      const configPath = this.writeConfig(proxyPort, adminPort);

      // NOTE: no --adapter flag. The config file is already Caddy's native
      // JSON format; passing `--adapter json` errors on modern Caddy
      // ("unrecognized config adapter: json") — adapters are only for
      // non-native formats (e.g. Caddyfile) that need converting INTO JSON.
      // Verified directly against the real caddy binary (v2.11.3) during
      // implementation of this file.
      const child = spawn(bin, ['run', '--config', configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        await this.waitForHealthy(adminPort, child);

        this.child = child;
        this.proxyPort = proxyPort;
        this.adminPort = adminPort;
        this.configPath = configPath;
        this.started = true;
        this.lastProxyPort = proxyPort;
        this.lastAppliedTarget = null;
        this.installExitHandler(child);

        if (priorProxyPort != null && proxyPort !== priorProxyPort) {
          logger.error(`Caddy proxy port changed on respawn: ${priorProxyPort} -> ${proxyPort}`);
          for (const cb of this.portChangedListeners) {
            try {
              cb(`http://127.0.0.1:${proxyPort}`);
            } catch (cbErr) {
              logger.warn(`onPortChanged listener threw: ${cbErr}`);
            }
          }
        }
        return;
      } catch (err) {
        try {
          child.kill();
        } catch {
          // already dead
        }
        try {
          fs.unlinkSync(configPath);
        } catch {
          // best effort
        }

        if (err instanceof CaddyBinaryNotFoundError) {
          // Retrying with a different port can never fix a missing binary —
          // fail fast, don't burn the second attempt.
          throw err;
        }

        if (useSticky) stickyAttemptFailed = true;
        if (attempt === 2) {
          throw stickyAttemptFailed
            ? new CaddyPortReclaimError(`Both proxy-port reclaim and fresh-port fallback failed: ${err}`)
            : new CaddyStartupError(String(err));
        }
      }
    }
  }

  /** Restart policy: lazy, bounded, next-call-triggered — no background
   *  watchdog (matches ngrokAgentSession.ts's onTerminated philosophy). This
   *  handler only marks state as dead; it never itself triggers a respawn. */
  private installExitHandler(child: ChildProcess): void {
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        logger.warn(`Caddy process exited unexpectedly (code=${code}, signal=${signal})`);
        this.started = false;
        this.child = null;
      }
    });
  }
}

/** Default factory — one fresh instance per session key (never a process-wide singleton). */
export function createCaddyProxy(opts?: CaddyProxyManagerOptions): CaddyProxy {
  return new CaddyProxyManager(opts);
}
