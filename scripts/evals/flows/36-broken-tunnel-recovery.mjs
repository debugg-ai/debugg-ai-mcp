/**
 * Broken-tunnel teardown contract.
 *
 * When the post-tunnel health probe fails and the handler returns
 * TunnelTrafficBlocked, it fires `tunnelManager.stopTunnel(...)` WITHOUT
 * awaiting it (fire-and-forget, see testPageChangesHandler.ts). That means
 * a subsequent call landing in the same millisecond window could theoretically
 * find the broken tunnel still in the shared registry and reuse it.
 *
 * This flow locks two invariants against that race:
 *
 *   (1) Eventual consistency — within a reasonable wait (~10s), the file-
 *       backed registry entry for the dead port is gone. If this fails,
 *       we have a leak: every broken tunnel pollutes the registry forever.
 *
 *   (2) No stale/cached results — a second call to the same zombie port
 *       must produce its OWN fresh health-probe timeout, not a cached
 *       answer from the first call. We assert each call's
 *       detail.elapsedMs is real (~5000ms, i.e. the probe ran to timeout),
 *       not a tiny number indicating a short-circuit from cached state.
 *
 * Tagged 'tunnel' — provisions a real ngrok tunnel.
 */

import { createServer as createNetServer } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGISTRY_FILE = join(tmpdir(), 'debugg-ai-tunnels.json');

function readRegistry() {
  if (!existsSync(REGISTRY_FILE)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function callCheck(client, url, timeoutMs = 60_000) {
  const started = Date.now();
  const r = await client.request('tools/call', {
    name: 'check_app_in_browser',
    arguments: { url, description: 'broken-tunnel-recovery probe' },
  }, timeoutMs);
  return { r, elapsed: Date.now() - started };
}

export const flow = {
  name: 'broken-tunnel-recovery',
  tags: ['tunnel', 'bead-1om'],
  description: 'After a TunnelTrafficBlocked failure, registry entry is cleaned up and subsequent calls do their own fresh health probe (no stale/cached state)',
  async run({ client, step, assert, writeArtifact }) {
    const heldSockets = [];
    const server = createNetServer((socket) => {
      heldSockets.push(socket);
      socket.on('error', () => { /* ignore */ });
      socket.on('close', () => {
        const idx = heldSockets.indexOf(socket);
        if (idx >= 0) heldSockets.splice(idx, 1);
      });
      // Never respond.
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
    console.log(`  \x1b[2mzombie server: ${url}\x1b[0m`);

    try {
      let firstBody;

      await step(`call 1: TunnelTrafficBlocked with real ~5s health-probe timeout`, async () => {
        const { r, elapsed } = await callCheck(client, url);
        await writeArtifact('call1-response.json', r);
        await writeArtifact('call1-timing.json', { elapsedMs: elapsed });

        assert(r.isError === true, `call 1: expected isError:true; got ${JSON.stringify(r).slice(0, 300)}`);
        firstBody = JSON.parse(r.content[0].text);
        assert(firstBody.error === 'TunnelTrafficBlocked',
          `call 1: expected TunnelTrafficBlocked; got ${firstBody.error}`);
        // Real health-probe work happened — elapsedMs reflects actual timeout,
        // not a tiny number that would suggest cached error
        assert(firstBody.detail?.elapsedMs >= 4500 && firstBody.detail?.elapsedMs <= 6000,
          `call 1: detail.elapsedMs=${firstBody.detail?.elapsedMs} should be ~5000ms (real health probe ran to its 5s timeout)`);
      });

      await step('registry entry for the dead port is cleaned up within 10s of TunnelTrafficBlocked', async () => {
        // Poll the registry until the entry is gone. stopTunnel is fire-and-
        // forget, so there's a small async window between handler return and
        // registry cleanup — we accept up to 10s of that window.
        const deadline = Date.now() + 10_000;
        let snapshot;
        while (Date.now() < deadline) {
          snapshot = readRegistry();
          if (!snapshot[String(port)]) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        await writeArtifact('registry-after-wait.json', snapshot ?? {});
        assert(
          !snapshot || !snapshot[String(port)],
          `Registry still has an entry for port ${port} after 10s. stopTunnel's registry-delete path didn't run — this is a leak. Entry: ${JSON.stringify(snapshot?.[String(port)])}`,
        );
      });

      await step('call 2 (same port, still zombie): independent TunnelTrafficBlocked, NOT a cached/stale result', async () => {
        const { r, elapsed } = await callCheck(client, url);
        await writeArtifact('call2-response.json', r);
        await writeArtifact('call2-timing.json', { elapsedMs: elapsed });

        assert(r.isError === true, `call 2: expected isError:true; got ${JSON.stringify(r).slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.error === 'TunnelTrafficBlocked',
          `call 2: expected TunnelTrafficBlocked; got ${body.error}`);
        // The killer assertion: call 2's elapsedMs MUST also be ~5000ms,
        // proving it ran its own health probe. If some caching snuck in
        // and returned the first call's result, elapsedMs would be tiny
        // (and/or unchanged — the same literal number as call 1).
        assert(body.detail?.elapsedMs >= 4500 && body.detail?.elapsedMs <= 6000,
          `call 2: detail.elapsedMs=${body.detail?.elapsedMs} should be ~5000ms (fresh health probe, not cached). This indicates stale state bled through from the first call.`);

        // And the two calls should have INDEPENDENT probe durations, not
        // the identical value you'd expect from a memoized error
        assert(body.detail.elapsedMs !== firstBody.detail.elapsedMs,
          `SUSPICIOUS: call 2 elapsedMs (${body.detail.elapsedMs}) is byte-identical to call 1 (${firstBody.detail.elapsedMs}) — looks like a cached response`);
      });

      await step('registry is clean AGAIN after call 2 (teardown path runs on every failure, not just the first)', async () => {
        const deadline = Date.now() + 10_000;
        let snapshot;
        while (Date.now() < deadline) {
          snapshot = readRegistry();
          if (!snapshot[String(port)]) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        await writeArtifact('registry-final.json', snapshot ?? {});
        assert(
          !snapshot || !snapshot[String(port)],
          `Registry still has port ${port} after call 2 teardown — leak compounds on repeat failures`,
        );
      });
    } finally {
      for (const s of heldSockets) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
