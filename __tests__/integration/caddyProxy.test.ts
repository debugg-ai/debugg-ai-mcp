/**
 * CaddyProxy integration tests against a REAL `caddy` binary.
 *
 * Self-skips (via `describe.skip`) when `caddy` isn't discoverable on PATH —
 * this file, like the rest of __tests__/integration, is picked up by both
 * the default `npm test` and `npm run test:integration`, and must never fail
 * `npm test` in an environment without the caddy binary installed (see
 * docs/local-tunnel-multiplexer-architecture-2026-07-31.md §4/§5.3).
 *
 * No module mocking here on purpose — __tests__/services/caddyProxy.test.ts
 * owns the mocked-spawn/http unit coverage; this file exercises the real
 * child process + real admin API + real proxying.
 */

import { execSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaddyProxyManager } from '../../services/caddy/caddyProxy.js';

function caddyAvailable(): boolean {
  try {
    execSync('caddy version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_CADDY = caddyAvailable();
const maybeDescribe = HAS_CADDY ? describe : describe.skip;

if (!HAS_CADDY) {
  // eslint-disable-next-line no-console
  console.log(
    'Skipping Caddy real-binary integration tests — `caddy` not found on PATH. ' +
    'Install: brew install caddy (macOS) / apt install caddy (Debian-Ubuntu) / https://caddyserver.com/docs/install',
  );
}

// ── Small test-only HTTP helpers ────────────────────────────────────────────

function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: http.OutgoingHttpHeaders; body?: string },
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers: options.headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (options.body != null) req.write(options.body);
    req.end();
  });
}

function startEchoServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('x-echo-host', req.headers.host ?? '');
        res.setHeader('x-echo-path', req.url ?? '');
        res.end(JSON.stringify({ receivedHost: req.headers.host, receivedPath: req.url, receivedBody: body }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

async function pollUntil(fn: () => Promise<boolean> | boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

maybeDescribe('CaddyProxy — real caddy binary integration', () => {
  let tmpDir: string;
  const managers: CaddyProxyManager[] = [];
  const servers: http.Server[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddyProxyIntegration-'));
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.stop().catch(() => {})));
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeManager(): CaddyProxyManager {
    const mgr = new CaddyProxyManager({ configDir: tmpDir, startTimeoutMs: 8000, probeIntervalMs: 100 });
    managers.push(mgr);
    return mgr;
  }

  test('real caddy accepts PATCH /id/dbg-handler after ensureStarted()', async () => {
    const mgr = makeManager();
    const handle = await mgr.ensureStarted();
    expect(handle.localPort).toBeGreaterThan(0);
    expect(handle.adminPort).toBeGreaterThan(0);

    const { server, port } = await startEchoServer();
    servers.push(server);

    await expect(mgr.setUpstream({ port })).resolves.toBeUndefined();
  }, 20000);

  test('real request through the proxy port round-trips body AND Host header unchanged (no header_up Host)', async () => {
    const { server, port } = await startEchoServer();
    servers.push(server);

    const mgr = makeManager();
    const handle = await mgr.ensureStarted();
    await mgr.setUpstream({ port });

    const res = await rawRequest(handle.localPort, {
      method: 'POST',
      path: '/api/foo',
      headers: { Host: 'my-custom-app-host.test:1234', 'Content-Type': 'text/plain' },
      body: 'hello-through-caddy',
    });

    expect(res.status).toBe(200);
    // Host-header hold-the-line contract (architecture doc §2.2): Caddy must
    // forward the Host header byte-identical — no header_up Host directive.
    expect(res.headers['x-echo-host']).toBe('my-custom-app-host.test:1234');
    const parsed = JSON.parse(res.body);
    expect(parsed.receivedBody).toBe('hello-through-caddy');
  }, 20000);

  test('Feb-root-cause regression: a root-absolute path (e.g. /api/foo) reaches the app — no /p/{port} prefix, no 404', async () => {
    const { server, port } = await startEchoServer();
    servers.push(server);

    const mgr = makeManager();
    const handle = await mgr.ensureStarted();
    await mgr.setUpstream({ port });

    const res = await rawRequest(handle.localPort, { method: 'GET', path: '/api/foo' });
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.receivedPath).toBe('/api/foo');
  }, 20000);

  test('real SIGKILL mid-session is detected and the next setUpstream() self-heals via a real respawn (sticky-port reclaim)', async () => {
    const { server, port } = await startEchoServer();
    servers.push(server);

    const mgr = makeManager();
    const first = await mgr.ensureStarted();
    await mgr.setUpstream({ port });

    const child = (mgr as unknown as { child: { pid: number } | null }).child;
    expect(child?.pid).toBeGreaterThan(0);
    process.kill(child!.pid, 'SIGKILL');

    // Wait for the exit handler to mark the manager as no-longer-started.
    await pollUntil(() => (mgr as unknown as { started: boolean }).started === false, 5000, 50);

    // Next call should self-heal: a fresh spawn, ideally reclaiming the same
    // sticky proxy port since the OS releases it almost immediately.
    await mgr.setUpstream({ port });
    const second = await mgr.ensureStarted();
    expect(second.localPort).toBeGreaterThan(0);

    const res = await rawRequest(second.localPort, { method: 'GET', path: '/api/foo' });
    expect(res.status).toBe(200);
  }, 25000);
});
