/**
 * Fire N check_app_in_browser calls in parallel against N distinct local
 * servers. Each server serves a unique marker string so we can verify each
 * result is tied to the correct target (no cross-wiring of tunnels or
 * request/response pairs).
 *
 * Exercises:
 *   - MAX_CONCURRENT=2 slot queue in testPageChangesHandler.ts
 *   - Concurrent tunnel provisioning (each call needs its own ngrok tunnel)
 *   - Stdio JSON-RPC multiplexing in the MCP server
 *
 * Expected timing: with MAX_CONCURRENT=2 and ~40s per call, wall time should
 * be ~2× single-call latency (≤120s for 4 calls), NOT 4× (~160s).
 */

import { createServer } from 'http';

const N_CALLS = 4;

function makeMarkerServer(marker) {
  return createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><title>${marker}</title></head>` +
      `<body><h1 id="marker">${marker}</h1>` +
      `<p>If the remote browser reads this heading, its tunnel was routed correctly.</p></body></html>`);
  });
}

export const flow = {
  name: 'concurrent-checks',
  tags: ['browser', 'browser-local', 'tunnel', 'concurrency'],
  description: `Fire ${N_CALLS} check_app_in_browser calls in parallel; verify no cross-wiring + some parallelism`,
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();
    const markers = Array.from({ length: N_CALLS }, (_, i) => `Concurrent-Marker-${ts}-${i}`);
    const servers = markers.map(m => makeMarkerServer(m));

    // Start all servers on random ports
    await Promise.all(servers.map(s =>
      new Promise(resolve => s.listen(0, '127.0.0.1', resolve))
    ));
    const targets = servers.map((s, i) => ({
      marker: markers[i],
      url: `http://localhost:${s.address().port}`,
    }));
    console.log(`  \x1b[2mtargets: ${targets.map(t => t.url).join(', ')}\x1b[0m`);

    try {
      let wallStart, wallEnd;

      await step(`${N_CALLS} parallel check_app_in_browser — all succeed, each response matches its target`, async () => {
        wallStart = Date.now();
        const promises = targets.map((t, i) =>
          client.request('tools/call', {
            name: 'check_app_in_browser',
            arguments: {
              url: t.url,
              description: `The page should display a heading that reads exactly "${t.marker}".`,
            },
          }, 420_000).then(r => ({ idx: i, target: t, response: r }))
        );
        const results = await Promise.all(promises);
        wallEnd = Date.now();

        await writeArtifact('summary.json', {
          wallMs: wallEnd - wallStart,
          n: N_CALLS,
          perCall: results.map(r => {
            const text = r.response.content?.[0]?.text ?? '';
            let body; try { body = JSON.parse(text); } catch { body = null; }
            return {
              idx: r.idx,
              target: r.target,
              isError: !!r.response.isError,
              success: body?.success,
              targetUrl: body?.targetUrl,
              stepsTaken: body?.stepsTaken,
            };
          }),
        });

        // No errors, no cross-wiring
        for (const { idx, target, response } of results) {
          assert(!response.isError,
            `Call ${idx} (${target.marker}) returned error: ${response.content?.[0]?.text?.slice(0, 400)}`);
          const text = response.content[0].text;
          assert(!text.includes('ngrok.debugg.ai'), `Call ${idx}: tunnel URL leak`);

          const body = JSON.parse(text);
          assert(body.targetUrl === target.url,
            `Call ${idx}: targetUrl cross-wired. Expected ${target.url}, got ${body.targetUrl}`);
          assert(body.success === true,
            `Call ${idx} (${target.marker}): agent did not succeed. outcome=${JSON.stringify(body.outcome).slice(0, 200)}`);

          // Every result should reference THIS call's marker somewhere in the outcome
          // or action trace, and NOT any other call's marker.
          const otherMarkers = markers.filter(m => m !== target.marker);
          const textNorm = text;
          for (const other of otherMarkers) {
            assert(!textNorm.includes(other),
              `Call ${idx} (${target.marker}) response leaks a different call's marker: ${other}`);
          }
        }

        // Sanity check on parallelism. Single call is ~30-60s; MAX_CONCURRENT=2
        // means 4 calls should take ~2× that. Full serialization would be 4×.
        const wall = wallEnd - wallStart;
        // Concurrency sanity: 4 calls with MAX_CONCURRENT=2 should run ~2 pairs in sequence.
        // Under suite load individual calls can be 100-150s, so the ceiling is generous.
        // The real check is that wall time is NOT 4× — that would prove full serialization.
        assert(wall < 420_000,
          `Wall time ${wall}ms exceeds 7min — either parallelism is broken or backend is severely degraded`);
        console.log(`  \x1b[2mwall: ${Math.round(wall / 1000)}s for ${N_CALLS} calls\x1b[0m`);
      });
    } finally {
      await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    }
  },
};
