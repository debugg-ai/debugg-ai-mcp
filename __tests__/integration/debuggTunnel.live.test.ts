/**
 * A REAL debugg tunnel against a live backend and tunnel server
 * (bead debugg_ai_mcp-xkoh.5.4, wired in 4.2).
 *
 * This is the only test in the arc that leaves the machine, and it is the one
 * that would catch anything the in-process fake gets wrong about nginx, the
 * ALB, TLS or the handshake. There is no staging environment — the rollout is a
 * dark launch in prod behind the transport flag — so the target is a PARAMETER
 * rather than a hardcoded host, and 5.2 Manual Verification points it at prod
 * once the tunnel server is deployed.
 *
 * It self-skips unless BOTH are set, so `npm test` and `npm run test:integration`
 * stay clean everywhere else:
 *   DEBUGGAI_LIVE_TUNNEL_API_KEY  — an API key for the target environment
 *   DEBUGGAI_LIVE_TUNNEL_API_URL  — e.g. https://api.debugg.ai
 *
 * It provisions a tunnel, connects, probes it over the control channel and
 * revokes it. Provision and revoke are WRITES, so it never runs by accident.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { AxiosTransport } from '../../utils/axiosTransport.js';
import { createTunnelsService } from '../../services/tunnels.js';
import { createInMemoryRegistry } from '../../services/ngrok/tunnelRegistry.js';
import TunnelManager from '../../services/ngrok/tunnelManager.js';
import { probeTunnelHealth } from '../../utils/localReachability.js';

const LIVE_KEY = process.env.DEBUGGAI_LIVE_TUNNEL_API_KEY;
const LIVE_URL = process.env.DEBUGGAI_LIVE_TUNNEL_API_URL;
const ENABLED = !!LIVE_KEY && !!LIVE_URL;

const maybeDescribe = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log(
    'Skipping live debugg tunnel test — set DEBUGGAI_LIVE_TUNNEL_API_KEY and ' +
    'DEBUGGAI_LIVE_TUNNEL_API_URL to run it (it provisions and revokes a real tunnel).',
  );
}

maybeDescribe('live debugg tunnel against a deployed backend', () => {
  let app: http.Server;
  let appPort: number;
  let tm: TunnelManager;

  beforeAll(async () => {
    app = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`staging tunnel reached ${req.url}`);
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    appPort = (app.address() as AddressInfo).port;
    tm = new TunnelManager(createInMemoryRegistry());
  });

  afterAll(async () => {
    await tm.stopAllTunnels().catch(() => {});
    await new Promise<void>((r) => app.close(() => r()));
  });

  test('provision -> connect -> serve -> probe -> revoke', async () => {
    const tx = new AxiosTransport({ baseUrl: LIVE_URL!, apiKey: LIVE_KEY! });
    const tunnels = createTunnelsService(tx) as any;

    const provision = await tunnels.provision('mcp_integration_test');

    // The backend decides the transport, behind the rollout flag. If this
    // account is not in the dark launch yet the answer is ngrok, and there is
    // nothing here to assert — report it rather than failing a run that is
    // correctly configured.
    if (provision.transport !== 'debugg') {
      // eslint-disable-next-line no-console
      console.log(`Backend selected transport "${provision.transport}" — skipping the debugg assertions.`);
      return;
    }

    expect(provision.relayUrl).toMatch(/^wss:\/\//);
    expect(provision.tunnelDomain).toContain('.');

    const info = await (tm as any).ensureSessionTunnel(
      'live-itest',
      provision.tunnelKey,
      provision.tunnelId,
      provision.keyId,
      undefined,
      provision,
    );

    try {
      expect(info.tunnelUrl).toBe(`https://${provision.tunnelId}.${provision.tunnelDomain}`);

      const route = await info.portLock.acquire({ port: appPort, isHttpsLocal: false }, { callId: 'live-itest' });
      try {
        // The tunnel hostname is private to the VPC, so the health check has to
        // come back over the control channel — this asserts the real server
        // answers PROBE, through the real nginx and ALB.
        const health = await probeTunnelHealth(`${info.tunnelUrl}/live`);
        expect(health.healthy).toBe(true);
        expect(health.status).toBe(200);
      } finally {
        route.release();
      }
    } finally {
      await tm.stopTunnel(info.tunnelId);
      await tunnels.revoke(provision);
    }
  }, 60000);
});
