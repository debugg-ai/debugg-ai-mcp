/**
 * Bead 1om regression fence, tier 2: post-tunnel health probe must catch
 * a "zombie" dev server.
 *
 * Flow 28 proves pre-flight fails fast when nothing is listening. This flow
 * proves the NEXT layer of defense — the tunnel health probe — catches a
 * server that accepts TCP (so pre-flight passes) but never responds to HTTP
 * (the exact behaviour you'd see from a backend that crashed post-bind, is
 * deadlocked waiting on a DB, or has a stuck event loop).
 *
 * Test mechanism: raw net.Server accepts connections and holds sockets open
 * without writing a byte. No timing tricks, no race windows.
 *
 * Expected chain inside the handler:
 *   1. probeLocalPort(port) → reachable:true (TCP connects)
 *   2. provision tunnel → OK
 *   3. probeTunnelHealth(tunnelUrl) → fetch times out after 5s
 *      OR ngrok returns 502/504 with an ERR_NGROK marker
 *   4. handler returns {error:'TunnelTrafficBlocked', isError:true}
 *   5. tunnelManager.stopTunnel is fired (fire-and-forget, no await)
 *
 * The key assertion is #4 — and critically, that this happens WITHOUT
 * running the browser agent. A zombie server must not trigger a multi-
 * minute false-pass.
 *
 * Tagged 'tunnel' — uses real ngrok provision path, but no browser agent,
 * so ~10-15s not minutes.
 */

import { createServer as createNetServer } from 'node:net';

const VALID_HEALTH_FAIL_CODES = new Set([
  'TIMEOUT',       // fetch aborted after 5s waiting for HTTP response
  'NGROK_ERROR',   // ngrok detected upstream didn't respond → ERR_NGROK_*
  'BAD_GATEWAY',   // ngrok returned 502/504 without an error marker
  'NETWORK_ERROR', // underlying fetch failed (less likely but valid)
]);

export const flow = {
  name: 'zombie-server-health-fail',
  tags: ['tunnel', 'bead-1om'],
  description: 'Zombie server (TCP-accept + never-respond) triggers TunnelTrafficBlocked via post-tunnel health probe, no browser agent runs',
  async run({ client, step, assert, writeArtifact }) {
    // Raw TCP server that accepts but never writes. Holds sockets open so
    // ngrok's dial succeeds — we want the failure to surface at the HTTP
    // layer, not the TCP layer (flow 28 already covers TCP-refused).
    const heldSockets = [];
    const server = createNetServer((socket) => {
      heldSockets.push(socket);
      socket.on('error', () => { /* ignore — peer may RST */ });
      socket.on('close', () => {
        const idx = heldSockets.indexOf(socket);
        if (idx >= 0) heldSockets.splice(idx, 1);
      });
      // Deliberately never call socket.write / socket.end
    });

    const port = await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr !== 'object' || !addr) return reject(new Error('no addr'));
        resolve(addr.port);
      });
    });
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mzombie server: ${url} (TCP accepts, HTTP never responds)\x1b[0m`);

    try {
      await step('sanity: TCP to zombie server connects (so pre-flight passes)', async () => {
        const { createConnection } = await import('node:net');
        const connected = await new Promise((resolve) => {
          const s = createConnection({ host: '127.0.0.1', port, timeout: 1000 });
          s.once('connect', () => { s.destroy(); resolve(true); });
          s.once('timeout', () => { s.destroy(); resolve(false); });
          s.once('error', () => resolve(false));
        });
        assert(connected, `Pre-check: 127.0.0.1:${port} should accept TCP but didn't — test setup broken`);
      });

      await step(`check_app_in_browser against ${url} returns TunnelTrafficBlocked (not a 5-minute false pass)`, async () => {
        const started = Date.now();
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description: 'any — should never actually run; health probe must catch zombie backend',
          },
        }, 60_000); // 60s allowance; expect ~10-15s (pre-flight + provision + 5s health timeout)
        const elapsed = Date.now() - started;

        await writeArtifact('zombie-response.json', r);
        await writeArtifact('timing.json', { port, url, elapsedMs: elapsed });

        // Response must arrive fast — the browser agent has a ~5min cap, and
        // the whole bead-1om contract is that we fail BEFORE reaching it.
        assert(elapsed < 30_000, `response took ${elapsed}ms — health probe must bail within ~5-15s, not run the browser agent`);

        assert(r.isError === true, `expected isError:true for zombie server; got: ${JSON.stringify(r).slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        assert(
          body.error === 'TunnelTrafficBlocked',
          `expected error='TunnelTrafficBlocked' from post-tunnel health probe; got: ${body.error} — full body: ${JSON.stringify(body).slice(0, 500)}`,
        );

        // Classify the failure reason — any of the known fail codes is valid
        // because ngrok's exact behavior for "upstream accepts TCP but no HTTP"
        // depends on ngrok internals (may 504, may ERR_NGROK_3200, may just
        // hang until our 5s timeout). Lock the contract, not the specific code.
        assert(
          VALID_HEALTH_FAIL_CODES.has(body.detail?.code),
          `expected detail.code in [${[...VALID_HEALTH_FAIL_CODES].join(', ')}]; got: ${body.detail?.code}`,
        );

        // Critical false-positive guard: no outcome:'pass' on a zombie server
        assert(
          body.outcome !== 'pass',
          `HARD FAIL: tool returned outcome='pass' against a zombie server. The health probe didn't catch it — falls back to the bead-1om false-pass class.`,
        );

        // Sanity on the message — must actually reference tunnel/traffic, not
        // something misleading like "LocalServerUnreachable" (which would hint
        // the probe layering is confused)
        assert(
          typeof body.message === 'string' && /tunnel|traffic/i.test(body.message),
          `expected message to reference tunnel/traffic; got: "${body.message}"`,
        );
      });

      await step('trigger_crawl against zombie server ALSO returns TunnelTrafficBlocked (crawl handler shares the probe)', async () => {
        const started = Date.now();
        const r = await client.request('tools/call', {
          name: 'trigger_crawl',
          arguments: { url },
        }, 60_000);
        const elapsed = Date.now() - started;

        await writeArtifact('zombie-crawl-response.json', r);

        assert(elapsed < 30_000, `trigger_crawl took ${elapsed}ms on zombie server — crawl handler must fail fast too`);
        assert(r.isError === true, `trigger_crawl should error on zombie server; got: ${JSON.stringify(r).slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(
          body.error === 'TunnelTrafficBlocked',
          `trigger_crawl: expected error='TunnelTrafficBlocked'; got: ${body.error}`,
        );
        assert(
          body.status !== 'completed' && body.crawlSummary?.success !== true,
          `HARD FAIL: trigger_crawl returned success on zombie server (health probe missed it)`,
        );
      });
    } finally {
      // Release any held sockets first so server.close doesn't hang
      for (const s of heldSockets) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
