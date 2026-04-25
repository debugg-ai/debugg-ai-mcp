/**
 * Bead fhg regression fence: IPv6-only dev server.
 *
 * Some frameworks (Node's default HTTP server if you pass '::1', some
 * Python frameworks, default Rust servers) bind to IPv6 loopback only.
 * When ngrok / our pre-flight probe dials 127.0.0.1, they see ECONNREFUSED
 * — because nothing is listening on IPv4 loopback.
 *
 * Two layers must behave correctly for this to surface as a helpful error
 * instead of the 2026-04-24 false-positive:
 *   (a) Pre-flight probeLocalPort defaults to 127.0.0.1 (matching ngrok's
 *       IPv4-forced dial from bead fhg) — so an IPv6-only server fails
 *       this probe fast.
 *   (b) If (a) somehow misses, the tunnel health probe should catch
 *       ERR_NGROK_8012 from ngrok and surface TunnelTrafficBlocked.
 *
 * We assert path (a) here because the probe runs before any backend work
 * and is the faster, cheaper signal. 'fast' tag — no real browser.
 *
 * Skip gracefully on platforms/CI where IPv6 loopback is unavailable.
 */

import { createServer } from 'node:http';
import { createConnection } from 'node:net';

async function canBindIpv6Only() {
  // Probe whether the CI host supports ::1 binding. Some containers run
  // with IPv6 disabled at the kernel level — a skip is correct there.
  return new Promise((resolve) => {
    const s = createServer();
    s.on('error', () => resolve(false));
    try {
      s.listen(0, '::1', () => {
        s.close(() => resolve(true));
      });
    } catch {
      resolve(false);
    }
  });
}

async function startIpv6OnlyServer() {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>ipv6-only</h1>');
  });
  const port = await new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(0, '::1', () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || !addr) return reject(new Error('no addr'));
      resolve(addr.port);
    });
  });
  return { srv, port };
}

async function verifyIpv6Reachable(port) {
  // Sanity check: the server really IS listening, just on ::1 only.
  // If this fails we'd get a passing test for the wrong reason.
  return new Promise((resolve) => {
    const sock = createConnection({ host: '::1', port, timeout: 1000 });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

async function verifyIpv4Refused(port) {
  // The whole point: IPv4 side is NOT listening.
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port, timeout: 1000 });
    sock.once('connect', () => { sock.destroy(); resolve(false); }); // should NOT connect
    sock.once('timeout', () => { sock.destroy(); resolve(false); }); // timeout means something weird
    sock.once('error', (err) => resolve(err.code === 'ECONNREFUSED'));
  });
}

export const flow = {
  name: 'ipv6-only-bind',
  tags: ['fast', 'protocol', 'bead-fhg', 'bead-1om'],
  description: 'Server bound to ::1 only returns LocalServerUnreachable from pre-flight probe instead of blazing into ngrok (bead fhg + 1om fence)',
  async run({ client, step, assert, writeArtifact, skip }) {
    if (!(await canBindIpv6Only())) {
      if (typeof skip === 'function') {
        return skip('IPv6 loopback not available on this host');
      }
      console.log('  \x1b[2mskipping: IPv6 loopback (::1) not available on this host\x1b[0m');
      return;
    }

    const { srv, port } = await startIpv6OnlyServer();
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mipv6-only server: ${url} (bound to ::1 port ${port})\x1b[0m`);

    try {
      await step('pre-check: server IS reachable via ::1 but NOT via 127.0.0.1', async () => {
        const ipv6Ok = await verifyIpv6Reachable(port);
        const ipv4Refused = await verifyIpv4Refused(port);
        await writeArtifact('preflight-sanity.json', { port, ipv6Ok, ipv4Refused });
        assert(ipv6Ok, `Sanity: server should be reachable on ::1:${port} but probe refused — test setup broken`);
        assert(ipv4Refused, `Sanity: 127.0.0.1:${port} should refuse but didn't — test wouldn't be exercising the bug`);
      });

      await step(`check_app_in_browser against ${url} returns LocalServerUnreachable in <10s (not a false-pass)`, async () => {
        const started = Date.now();
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description: 'any — should never actually run because IPv4 loopback is dead',
          },
        }, 20_000);
        const elapsed = Date.now() - started;

        await writeArtifact('ipv6-only-response.json', r);
        await writeArtifact('timing.json', { port, url, elapsedMs: elapsed });

        assert(elapsed < 10_000, `response took ${elapsed}ms — pre-flight probe must fail in ~1.5s, not wait for backend/ngrok`);

        assert(r.isError === true, `expected isError:true for IPv6-only server; got: ${JSON.stringify(r).slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        assert(
          body.error === 'LocalServerUnreachable',
          `expected error='LocalServerUnreachable' (ngrok only speaks IPv4 so this is the right UX); got: ${body.error} — full body: ${JSON.stringify(body).slice(0, 300)}`,
        );
        assert(
          body.detail?.port === port,
          `expected detail.port=${port}; got: ${body.detail?.port}`,
        );
        // The killer assertion — same class of false-positive as bead 1om
        assert(
          body.outcome !== 'pass',
          `HARD FAIL: tool returned outcome='pass' against an IPv6-only server (ngrok can't reach it on IPv4). This is the exact 2026-04-24 false-positive class, just triggered by a different root cause.`,
        );
      });

      await step('trigger_crawl against IPv6-only server ALSO fails fast (not just check_app_in_browser)', async () => {
        const started = Date.now();
        const r = await client.request('tools/call', {
          name: 'trigger_crawl',
          arguments: { url },
        }, 20_000);
        const elapsed = Date.now() - started;

        await writeArtifact('ipv6-only-crawl-response.json', r);

        assert(elapsed < 10_000, `trigger_crawl took ${elapsed}ms on IPv6-only server — probe must fail fast for this tool too`);
        assert(r.isError === true, `trigger_crawl should error on IPv6-only server; got: ${JSON.stringify(r).slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(
          body.error === 'LocalServerUnreachable',
          `trigger_crawl: expected error='LocalServerUnreachable'; got: ${body.error}`,
        );
        assert(
          body.status !== 'completed' && body.crawlSummary?.success !== true,
          `HARD FAIL: trigger_crawl returned success against IPv6-only server`,
        );
      });
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  },
};
