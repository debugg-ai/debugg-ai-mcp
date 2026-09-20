/**
 * The debugg transport, end to end through a REAL Caddy and a REAL local app
 * (bead debugg_ai_mcp-xkoh.5.4, phase 2.2).
 *
 * What is real here: the MCP's own tunnel stack (TunnelManager, the debugg
 * transport, the per-session Caddy process, PortLock, probeTunnelHealth) and a
 * throwaway HTTP app on loopback. What is faked: the tunnel SERVER, built on
 * the shared protocol module in services/tunnel/protocol/ — which is the point,
 * because that module is the contract the real server will be built from. The
 * backend is not involved at all: provision is simulated by handing
 * TunnelManager the transport selection a provision response would carry.
 *
 * The shape mirrors the production path exactly:
 *
 *   fake ingress (a browser) -> control websocket -> debuggTransport
 *     -> Caddy (real process) -> local app (real server)
 *
 * Self-skips when `caddy` is not on PATH, like
 * __tests__/integration/caddyProxy.test.ts: this directory is picked up by
 * `npm test` as well as `npm run test:integration`, and must never fail a
 * machine that has no caddy installed.
 *
 * RED on purpose: the transport and the protocol codec are stubs.
 */

import { jest } from '@jest/globals';
import { execSync } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createInMemoryRegistry } from '../../services/tunnel/tunnelRegistry.js';
import TunnelManager from '../../services/tunnel/tunnelManager.js';
import { probeTunnelHealth } from '../../utils/localReachability.js';
import { disposeUnhealthyTunnel } from '../../utils/tunnelDisposition.js';
import { FakeTunnelServerForTests } from './debuggTunnelServer.js';

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
  console.log('Skipping debugg tunnel integration tests — `caddy` not found on PATH.');
}

const TUNNEL_ID = 'itest-tunnel';
const TUNNEL_DOMAIN = 'tunnel.debugg.ai';
const HOST = `${TUNNEL_ID}.${TUNNEL_DOMAIN}`;

/** One browser request through the tunnel's ingress. */
function browserRequest(port: number, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { Host: HOST, Connection: 'close' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A browser POST with a large body, written straight to the tunnel ingress. */
function browserUpload(port: number, path: string, body: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { Host: HOST, Connection: 'close', 'Content-Length': String(body.length) },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

maybeDescribe('debugg tunnel: transport + Caddy + local app', () => {
  let app: http.Server;
  let appPort: number;
  let server: FakeTunnelServerForTests;
  let tm: TunnelManager;
  let tunnelId: string | undefined;

  beforeEach(async () => {
    app = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`app says hello from ${req.url}`);
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    appPort = (app.address() as AddressInfo).port;

    server = new FakeTunnelServerForTests(HOST);
    await server.start();

    tm = new TunnelManager(createInMemoryRegistry());
    tm.connectBackoffMs = [50, 100];

    // Fail fast if the transport seam ever goes missing, so a red run reports
    // THAT rather than a pile of downstream confusion.
    expect(typeof tm.transport?.connect).toBe('function');
  }, 20000);

  afterEach(async () => {
    await tm.stopAllTunnels().catch(() => {});
    await server.stop();
    await new Promise<void>((r) => app.close(() => r()));
    tunnelId = undefined;
    // Hooks get jest's DEFAULT timeout, not the per-test one: stopping a real
    // Caddy plus a websocket server needs more than 5s on a loaded machine.
  }, 20000);

  async function openTunnel() {
    const info = await (tm as any).ensureSessionTunnel(
      'itest-session',
      'tunnel-key-itest',
      TUNNEL_ID,
      'kid-itest',
      undefined,
      { relayUrl: server.relayUrl, tunnelDomain: TUNNEL_DOMAIN },
    );
    tunnelId = info.tunnelId;
    const route = await info.portLock.acquire({ port: appPort, isHttpsLocal: false }, { callId: 'itest' });
    return { info, route };
  }

  test('a browser request reaches the local app through the tunnel and Caddy', async () => {
    const { info, route } = await openTunnel();
    try {
      expect(info.tunnelUrl).toBe(`https://${HOST}`);
      expect(server.connected).toBe(true);

      const res = await browserRequest(server.ingressPort, '/dashboard');

      expect(res.status).toBe(200);
      expect(res.body).toContain('app says hello from /dashboard');
    } finally {
      route.release();
    }
  }, 20000);

  test('a payload many windows larger than one credit window survives the round trip', async () => {
    // The protocol arc lost a whole afternoon to a flow-control deadlock that
    // 225 unit tests could not see: node's flowing mode hands push()ed chunks
    // straight to a 'data' listener without going through read(), so
    // consumption accounting drifted and anything bigger than one window
    // stalled. Only a payload spanning SEVERAL windows end to end catches that
    // class of bug, so this test exists specifically to keep catching it.
    //
    // INITIAL_WINDOW is 256 KiB and MAX_DATA_PAYLOAD 64 KiB, so 4 MiB is ~16
    // windows and ~64 DATA frames, and it only completes if WINDOW updates
    // actually flow back.
    const payload = Buffer.alloc(4 * 1024 * 1024, 'x').toString('utf8');
    await new Promise<void>((r) => app.close(() => r()));
    app = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(payload.length) });
      res.end(payload);
    });
    await new Promise<void>((r) => app.listen(appPort, '127.0.0.1', r));

    const { route } = await openTunnel();
    try {
      const res = await browserRequest(server.ingressPort, '/big');

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(payload.length);
      expect(res.body).toBe(payload);
    } finally {
      route.release();
    }
  }, 30000);

  test('a multi-window UPLOAD arrives complete at the local app', async () => {
    // The other direction from the download test, and the one a hand-rolled
    // harness gets wrong: here the SERVER is the sender, so it only completes
    // if the client's WINDOW grants are honoured. The server arc's hand-rolled
    // client ignored WINDOW and truncated a 2 MiB transfer at ~1.5 MB, which is
    // why both ends of this harness now run the real protocol session.
    const body = Buffer.alloc(3 * 1024 * 1024, 'u');
    await new Promise<void>((r) => app.close(() => r()));
    app = http.createServer((req, res) => {
      let received = 0;
      req.on('data', (chunk) => { received += chunk.length; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`received ${received}`);
      });
    });
    await new Promise<void>((r) => app.listen(appPort, '127.0.0.1', r));

    const { route } = await openTunnel();
    try {
      const res = await browserUpload(server.ingressPort, '/upload', body);

      expect(res.status).toBe(200);
      expect(res.body).toBe(`received ${body.length}`);
    } finally {
      route.release();
    }
  }, 30000);

  test('the handshake carried the protocol headers and no secret in the URL', async () => {
    const { route } = await openTunnel();
    try {
      expect(server.handshakes).toHaveLength(1);
      const headers = server.handshakes[0];
      expect(headers['authorization']).toBe('Bearer tunnel-key-itest');
      expect(headers['x-debugg-tunnel-id']).toBe(TUNNEL_ID);
      expect(String(headers['x-debugg-tunnel-protocol'])).toContain('1');
    } finally {
      route.release();
    }
  }, 20000);

  test('probeTunnelHealth answers over the control channel, never by fetching the private host', async () => {
    const { route } = await openTunnel();
    try {
      const health = await probeTunnelHealth(`https://${HOST}/health`, {
        fetchFn: (async () => { throw new Error('probe fetched the private tunnel host'); }) as any,
      });

      expect(health.healthy).toBe(true);
      expect(health.status).toBe(200);
    } finally {
      route.release();
    }
  }, 20000);

  test('with the app stopped, the probe reports a gateway failure and the tunnel is KEPT', async () => {
    const { route } = await openTunnel();
    try {
      await new Promise<void>((r) => app.close(() => r()));

      const health = await probeTunnelHealth(`https://${HOST}/health`, {
        fetchFn: (async () => { throw new Error('probe fetched the private tunnel host'); }) as any,
        retryBackoffMs: [10, 10],
      });
      expect(health.healthy).toBe(false);

      // Caddy answers 502 with no marker when its upstream is dead, so nothing
      // proves the TUNNEL is gone — it must survive, exactly as an
      // DEBUGG_TUNNEL_UPSTREAM_REFUSED means the tunnel is alive — leave it alone.
      disposeUnhealthyTunnel({ health, tunnelId, originalUrl: `http://localhost:${appPort}/` });
      await new Promise((r) => setTimeout(r, 50));

      expect(tm.getTunnelInfo(tunnelId!)).toBeDefined();
      expect(server.connected).toBe(true);
    } finally {
      route.release();
    }
  }, 20000);

  test('a GOAWAY mid-session reconnects, and the next browser request still works', async () => {
    // The deploy case from the design: the tunnel server sends GOAWAY on
    // SIGTERM and the client must make-before-break, keeping the same URL.
    const { info, route } = await openTunnel();
    try {
      server.goaway();
      await new Promise((r) => setTimeout(r, 300));

      expect(server.handshakes.length).toBeGreaterThanOrEqual(2);
      expect(server.connected).toBe(true);

      const res = await browserRequest(server.ingressPort, '/after-deploy');
      expect(res.status).toBe(200);
      expect(res.body).toContain('/after-deploy');
      expect(tm.getTunnelInfo(info.tunnelId)?.tunnelUrl).toBe(`https://${HOST}`);
    } finally {
      route.release();
    }
  }, 20000);

  test('stopTunnel closes the control socket and tears down that session Caddy', async () => {
    const { info, route } = await openTunnel();
    route.release();

    await tm.stopTunnel(info.tunnelId);
    await new Promise((r) => setTimeout(r, 100));

    expect(server.connected).toBe(false);
    expect(tm.getTunnelInfo(info.tunnelId)).toBeUndefined();
    expect(await info.caddy.isHealthy()).toBe(false);
  }, 20000);

  // ── The run_test_suite exception (§2.3) ────────────────────────────────────
  //
  // acquireDedicatedTunnel had NO end-to-end coverage: every test of it drives
  // a fake transport, so nothing proved the real transport, the real ingress
  // and probeTunnelHealth actually line up on this path. It is also the path
  // with the most to get wrong — it bypasses Caddy, dials the app directly,
  // builds its own hostname, and must use the tunnel id the BACKEND issued
  // (a client-minted uuid is not bound to the token and is refused with 401).
  describe('acquireDedicatedTunnel — dials the app directly, no Caddy', () => {
    const DEDICATED_ID = 'itest-dedicated';
    const DEDICATED_HOST = `${DEDICATED_ID}.${TUNNEL_DOMAIN}`;
    let dedicatedServer: FakeTunnelServerForTests;

    beforeEach(async () => {
      dedicatedServer = new FakeTunnelServerForTests(DEDICATED_HOST);
      await dedicatedServer.start();
    }, 20000);

    afterEach(async () => {
      await dedicatedServer.stop();
    }, 20000);

    function dedicatedRequest(path: string): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: dedicatedServer.ingressPort,
            path,
            headers: { Host: DEDICATED_HOST, Connection: 'close' },
          },
          (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    }

    test('a browser request reaches the app, and the URL keeps the caller path', async () => {
      const result = await tm.acquireDedicatedTunnel(
        `http://localhost:${appPort}/suite-target?run=1`,
        'tunnel-key-itest',
        'kid-dedicated',
        undefined,
        {
          relayUrl: dedicatedServer.relayUrl,
          tunnelDomain: TUNNEL_DOMAIN,
          tunnelId: DEDICATED_ID,
        },
      );
      tunnelId = result.tunnelId;

      // The BACKEND's id, not a client-minted uuid: the token is bound to it.
      expect(result.tunnelId).toBe(DEDICATED_ID);
      expect(result.url).toBe(`https://${DEDICATED_HOST}/suite-target?run=1`);
      expect(dedicatedServer.connected).toBe(true);

      const res = await dedicatedRequest('/suite-target?run=1');
      expect(res.status).toBe(200);
      expect(res.body).toContain('app says hello from /suite-target?run=1');
    }, 20000);

    test('probeTunnelHealth answers over THIS tunnel\'s control channel', async () => {
      // runTestSuiteHandler probes `dedicated.url`, which acquireDedicatedTunnel
      // builds with generateTunnelUrl rather than returning the transport's own
      // origin. If those two ever disagree on the hostname, the probe finds no
      // control channel and reports DEBUGG_TUNNEL_UNKNOWN — which the
      // disposition policy treats as proof the endpoint is gone and evicts a
      // perfectly healthy tunnel. Nothing else pins them together.
      const result = await tm.acquireDedicatedTunnel(
        `http://localhost:${appPort}/健康`,
        'tunnel-key-itest',
        undefined,
        undefined,
        {
          relayUrl: dedicatedServer.relayUrl,
          tunnelDomain: TUNNEL_DOMAIN,
          tunnelId: DEDICATED_ID,
        },
      );
      tunnelId = result.tunnelId;

      const health = await probeTunnelHealth(result.url);

      expect(health.healthy).toBe(true);
      expect(health.status).toBe(200);
      expect(health.tunnelErrorCode).toBeUndefined();
    }, 20000);

    test('stopTunnel closes the control socket and revokes the backend tunnel', async () => {
      const revokeKey = jest.fn(async () => {});
      const result = await tm.acquireDedicatedTunnel(
        `http://localhost:${appPort}/`,
        'tunnel-key-itest',
        'kid-dedicated',
        revokeKey,
        {
          relayUrl: dedicatedServer.relayUrl,
          tunnelDomain: TUNNEL_DOMAIN,
          tunnelId: DEDICATED_ID,
        },
      );

      await tm.stopTunnel(result.tunnelId);
      await new Promise((r) => setTimeout(r, 100));

      expect(dedicatedServer.connected).toBe(false);
      expect(revokeKey).toHaveBeenCalledTimes(1);
      // And the probe for that host now finds no control channel at all.
      const health = await probeTunnelHealth(result.url, { retryBackoffMs: [1, 1] });
      expect(health.healthy).toBe(false);
      expect(health.tunnelErrorCode).toBe('DEBUGG_TUNNEL_UNKNOWN');
    }, 20000);
  });
});
