/**
 * probe_page over the debugg transport, at the handler level
 * (bead debugg_ai_mcp-xkoh.5.4, phase 2.2).
 *
 * Only the BACKEND is faked here (provision, template lookup, execution and
 * polling). Everything the arc actually changes is real: the handler's own
 * tunnel plumbing, TunnelManager, the debugg transport, a real Caddy process,
 * PortLock, probeTunnelHealth and the response sanitizer. The "remote browser"
 * is simulated by the fake backend fetching the tunnel URL it was handed —
 * through the fake tunnel server's ingress, exactly as a real browser would.
 *
 * This is the test that pins the plumbing the four handlers need: the provision
 * response's transport fields have to reach TunnelManager, and the revoke has
 * to follow the transport. Without them the handler has no relay URL to connect to.
 *
 * Self-skips without `caddy` on PATH. RED on purpose.
 */

import { jest } from '@jest/globals';
import { execSync } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const HAS_CADDY = (() => {
  try { execSync('caddy version', { stdio: 'ignore' }); return true; } catch { return false; }
})();
const maybeDescribe = HAS_CADDY ? describe : describe.skip;

const TUNNEL_ID = 'itest-handler';
const TUNNEL_DOMAIN = 'tunnel.debugg.ai';
const HOST = `${TUNNEL_ID}.${TUNNEL_DOMAIN}`;

// ── Fake backend ─────────────────────────────────────────────────────────────

const observed = {
  contextData: undefined as any,
  browserFetchedPath: undefined as string | undefined,
  browserStatus: undefined as number | undefined,
  revokedVia: undefined as 'tunnels.revoke' | 'client.legacy' | undefined,
  revokedTunnelId: undefined as string | undefined,
};

let provision: any;
/** Set by the suite once the fake tunnel server is listening. */
let ingressPort = 0;
/** What the local app actually received, proving the chain end to end. */
let appReceived: string[] = [];

function browserFetch(tunnelUrl: string): Promise<{ status: number; body: string }> {
  const u = new URL(tunnelUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: ingressPort, path: `${u.pathname}${u.search}`, headers: { Host: u.host, Connection: 'close' } },
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

class FakeServerClient {
  // No expect() inside these: they run inside the handler's try/catch and
  // .catch() paths, where a failed assertion would be swallowed or resurface
  // as a confusing MCPError. They only RECORD; the test body asserts.
  tunnels = {
    provisionWithRetry: async () => provision,
    provision: async () => provision,
    revoke: async (p: any) => { observed.revokedVia = 'tunnels.revoke'; observed.revokedTunnelId = p?.tunnelId; },
  };

  workflows = {
    findTemplateBySlug: async () => ({ uuid: 'tpl-probe' }),
    executeWorkflow: async (_uuid: string, contextData: any) => {
      observed.contextData = contextData;
      // The "remote browser": it can only reach the app through the tunnel.
      const res = await browserFetch(contextData.targetUrl);
      observed.browserFetchedPath = new URL(contextData.targetUrl).pathname;
      observed.browserStatus = res.status;
      return { executionUuid: 'exec-1' };
    },
    pollExecution: async () => ({
      durationMs: 42,
      nodeExecutions: [{
        nodeType: 'browser.capture',
        status: 'success',
        executionOrder: 1,
        outputData: {
          // The backend reports the URL IT saw — the tunnel one. The handler
          // must rewrite it back to the caller's localhost origin.
          capturedUrl: `https://${HOST}/dashboard`,
          statusCode: 200,
          title: 'Dashboard',
          loadTimeMs: 12,
          consoleSlice: [],
          networkSummary: [],
        },
      }],
    }),
  };

  async init(): Promise<void> {}
  // The client used to expose revokeNgrokKey(); it is gone. Nothing here may
  // reach a revoke path other than tunnels.revoke().
}

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: FakeServerClient,
}));

let probePageHandler: typeof import('../../handlers/probePageHandler.js').probePageHandler;
let tunnelManager: typeof import('../../services/tunnel/tunnelManager.js').tunnelManager;

beforeAll(async () => {
  ({ probePageHandler } = await import('../../handlers/probePageHandler.js'));
  ({ tunnelManager } = await import('../../services/tunnel/tunnelManager.js'));
});

maybeDescribe('probe_page through a debugg tunnel', () => {
  let app: http.Server;
  let appPort: number;
  let server: any;

  beforeEach(async () => {
    appReceived = [];
    observed.contextData = undefined;
    observed.browserFetchedPath = undefined;
    observed.browserStatus = undefined;
    observed.revokedVia = undefined;
    observed.revokedTunnelId = undefined;

    app = http.createServer((req, res) => {
      appReceived.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><title>Dashboard</title><body>real app</body></html>');
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    appPort = (app.address() as AddressInfo).port;

    const { FakeTunnelServerForTests } = await import('./debuggTunnelServer.js');
    server = new FakeTunnelServerForTests(HOST);
    await server.start();
    ingressPort = server.ingressPort;

    provision = {
      tunnelId: TUNNEL_ID,
      tunnelKey: 'tunnel-key-handler',
      keyId: TUNNEL_ID,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      transport: 'debugg',
      relayUrl: server.relayUrl,
      tunnelDomain: TUNNEL_DOMAIN,
    };

    tunnelManager.connectBackoffMs = [50, 100];

    // Fail fast if the transport seam ever goes missing, so a red run reports
    // THAT rather than a pile of downstream confusion.
    expect(typeof (tunnelManager as any).transport?.connect).toBe('function');
  });

  afterEach(async () => {
    await tunnelManager.stopAllTunnels().catch(() => {});
    await server.stop();
    await new Promise<void>((r) => app.close(() => r()));
  });

  test('the backend gets a tunnel URL, the browser reaches the app, and no tunnel host leaks back', async () => {
    const response = await probePageHandler(
      {
        targets: [{ url: `http://localhost:${appPort}/dashboard`, waitForLoadState: 'domcontentloaded', timeoutMs: 10000 }],
        includeHtml: false,
        captureScreenshots: false,
      } as any,
      { timestamp: new Date() } as any,
    );

    // 1. The handler tunneled the target instead of handing over localhost.
    expect(observed.contextData.targetUrl).toBe(`https://${HOST}/dashboard`);

    // 2. The request travelled tunnel -> transport -> Caddy -> app.
    expect(appReceived).toContain('/dashboard');
    expect(observed.browserStatus).toBe(200);

    // 3. Nothing the caller sees mentions the tunnel.
    const text = (response.content[0] as any).text as string;
    expect(text).not.toContain(TUNNEL_DOMAIN);
    expect(text).toContain(`http://localhost:${appPort}`);
  }, 30000);

  test("the tunnel's revoke callback routes to the tunnels service", async () => {
    await probePageHandler(
      {
        targets: [{ url: `http://localhost:${appPort}/dashboard`, waitForLoadState: 'domcontentloaded', timeoutMs: 10000 }],
        includeHtml: false,
        captureScreenshots: false,
      } as any,
      { timestamp: new Date() } as any,
    );

    // Tunnels outlive a call by design (reuse + the 55-minute idle shutoff), so
    // the revoke fires when the tunnel is actually stopped. That callback is
    // what the handler built, and it must follow the transport the backend
    // owned by the tunnels service rather than any client-level revoke.
    await tunnelManager.stopAllTunnels();

    expect(observed.revokedVia).toBe('tunnels.revoke');
    expect(observed.revokedTunnelId).toBe(TUNNEL_ID);
  }, 30000);

  // Pins a KNOWN DEFECT, filed as bead debugg_ai_mcp-xkoh.9 and deliberately
  // not fixed in this arc.
  //
  // probePageHandler's orphan-revoke loop reads
  //   const tc = targetContexts[i]; if (tc && !tc.tunnelId && provision) ...
  // but when ensureTunnel throws, `targetContexts.push(tunneled)` never runs,
  // so `tc` is undefined and nothing is revoked — a provisioned tunnel is
  // leaked until it expires. It predates this arc (the same loop skipped
  // the client's own revoke) and probe_page is the only handler with
  // it, because it is the batch one.
  //
  // Whoever fixes xkoh.9 flips this assertion to expect 'tunnels.revoke'.
  test('a tunnel that never connects is NOT revoked today — pins bead xkoh.9', async () => {
    server.authorize = () => 401;

    await expect(
      probePageHandler(
        {
          targets: [{ url: `http://localhost:${appPort}/`, waitForLoadState: 'domcontentloaded', timeoutMs: 10000 }],
          includeHtml: false,
          captureScreenshots: false,
        } as any,
        { timestamp: new Date() } as any,
      ),
    ).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 100));
    expect(observed.revokedVia).toBeUndefined();
  }, 30000);
});
