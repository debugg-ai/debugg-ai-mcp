/**
 * Concurrent pre-flight probe cross-wiring check.
 *
 * Flow 11 covers concurrent browser-agent requests with the MAX_CONCURRENT=2
 * queue. This flow covers a different layer — the PRE-flight path. When
 * multiple localhost requests fail fast on the pre-flight probe, they must:
 *
 *   1. Each return its OWN port in detail.port (no cross-wiring of progress
 *      tokens, response bodies, or error payloads between in-flight calls).
 *   2. All complete quickly — pre-flight is per-call, should parallelize
 *      cleanly.
 *   3. None leak into the tunnel-provision or backend-execute paths.
 *
 * Cross-wiring at the pre-flight layer would be a class of bug distinct
 * from the browser-agent queue: shared module state, race on an error
 * builder, or a buggy progress-token→response mapping. This flow fires
 * N concurrent calls at N distinct dead ports and asserts strict 1:1
 * correspondence between request port and response port.
 *
 * Tagged 'fast' — no browser, no tunnel, no backend.
 */

import { createServer as createNetServer } from 'node:net';

const N_CALLS = 5;

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (typeof addr !== 'object' || !addr) return reject(new Error('no addr'));
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

export const flow = {
  name: 'concurrent-preflight',
  tags: ['fast', 'protocol', 'concurrency', 'bead-1om'],
  description: 'N concurrent pre-flight probes to distinct dead ports return strictly correlated responses (no cross-wiring)',
  async run({ client, step, assert, writeArtifact }) {
    // Pick N unique free ports (sequential picks so collisions are impossible)
    const ports = [];
    for (let i = 0; i < N_CALLS; i++) ports.push(await pickFreePort());
    // Make sure we got N unique — if the OS keeps handing out the same port
    // after close we'd weaken the test
    assert(new Set(ports).size === N_CALLS,
      `test setup: expected ${N_CALLS} unique ports, got: ${JSON.stringify(ports)}`);
    console.log(`  \x1b[2mports: ${ports.join(', ')}\x1b[0m`);

    let wallMs;

    await step(`fire ${N_CALLS} concurrent check_app_in_browser at distinct dead ports, all resolve in <15s total`, async () => {
      const started = Date.now();
      const promises = ports.map((port, idx) =>
        client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url: `http://localhost:${port}`,
            description: `concurrent probe #${idx} — port ${port}`,
          },
        }, 20_000).then((r) => ({ idx, port, r })),
      );
      const results = await Promise.all(promises);
      wallMs = Date.now() - started;

      await writeArtifact('summary.json', {
        wallMs,
        n: N_CALLS,
        perCall: results.map(({ idx, port, r }) => {
          const text = r.content?.[0]?.text ?? '';
          let body = null;
          try { body = JSON.parse(text); } catch {}
          return {
            idx,
            requestedPort: port,
            isError: !!r.isError,
            errorClass: body?.error,
            reportedPort: body?.detail?.port,
          };
        }),
      });

      // Wall time: each pre-flight is ~1-10ms; N parallel should be well
      // under 15s even on a slow host. If this trips, something is
      // serializing calls that shouldn't be.
      assert(wallMs < 15_000, `wall time ${wallMs}ms — concurrent pre-flight should finish in well under 15s`);

      // Every call failed with isError:true
      for (const { idx, r, port } of results) {
        assert(r.isError === true,
          `call #${idx} (port ${port}): expected isError:true; got ${JSON.stringify(r).slice(0, 200)}`);
      }
    });

    await step('strict 1:1 correlation — each response reports the EXACT port its request asked for (no cross-wiring)', async () => {
      // This is the killer assertion. If the MCP transport, progress-token
      // mapping, or error builder has shared state that leaks between
      // concurrent calls, we'd see a response for port A carrying
      // detail.port = B.
      const started = Date.now();
      const promises = ports.map((port, idx) =>
        client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url: `http://localhost:${port}`,
            description: `crosswire check #${idx} — port ${port}`,
          },
        }, 20_000).then((r) => ({ idx, port, r })),
      );
      const results = await Promise.all(promises);
      const elapsed = Date.now() - started;

      await writeArtifact('crosswire-raw.json', results.map(({ idx, port, r }) => ({ idx, port, r })));

      assert(elapsed < 15_000, `crosswire-check wall time ${elapsed}ms — unexpectedly slow`);

      for (const { idx, port, r } of results) {
        assert(r.isError === true, `call #${idx} (port ${port}): expected isError:true`);
        const body = JSON.parse(r.content[0].text);
        assert(body.error === 'LocalServerUnreachable',
          `call #${idx} (port ${port}): expected LocalServerUnreachable; got ${body.error}`);
        assert(
          body.detail?.port === port,
          `CROSS-WIRE: call #${idx} asked for port ${port} but response reports port ${body.detail?.port}. ` +
          `This is a concurrency bug — responses are mixing up between in-flight calls.`,
        );
      }

      // And verify the full set of reported ports matches the full set we asked for
      const requested = new Set(ports);
      const reported = new Set(results.map(({ r }) => JSON.parse(r.content[0].text).detail?.port));
      assert(reported.size === requested.size, `port-set size mismatch: requested ${requested.size}, reported ${reported.size}`);
      for (const p of requested) {
        assert(reported.has(p),
          `port ${p} was requested but never appears in any response — some call got lost or dropped`);
      }
    });
  },
};
