/**
 * probe_page integration tests — Phase 2.2 of /feature-lifecycle probe-page.
 *
 * Locks the end-to-end contract:
 *   1. Tool is registered + appears in tools/list
 *   2. Single-target probe against a public URL (smoke)
 *   3. Single-target probe against a localhost rich-content fixture proves
 *      networkSummary aggregates correctly (refetch loop = ONE row count=5,
 *      different paths = separate rows, console errors captured per level)
 *   4. Batch of 5 targets in ONE call returns 5 results in input order +
 *      single executionId
 *   5. Localhost dead-port returns LocalServerUnreachable in <2s
 *
 * MUST FAIL until Phase 4.1 (handler implementation) + Phase 4.2 (tool
 * registration) ship. Pre-implementation failure mode: tools/call returns
 * 'Unknown tool' error since probe_page isn't in the roster yet.
 *
 * Does NOT update flow 01's roster lock — that's 4.2's coupled change so
 * registration + roster-lock-bump happen atomically.
 */

import { createServer } from 'http';

// ── Rich-content fixture: deliberate console + multi-fetch including refetch loop
const FIXTURE_HTML = `<!DOCTYPE html><html><head>
<title>Probe Page Fixture</title>
<script>
  console.info('[fixture] inline script — page bootstrap');
  console.warn('[fixture] sample warning');
  console.error('[fixture] sample error (deliberate)');

  async function loadEverything() {
    const endpoints = ['/api/products', '/api/users', '/api/missing', '/api/server-error'];
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep);
        await r.text();
        console.log(\`[fixture] \${ep} → \${r.status}\`);
      } catch (e) {
        console.error(\`[fixture] \${ep} threw: \${e.message}\`);
      }
    }
    // Refetch-loop pattern — same path, different query strings.
    // networkSummary should aggregate these to ONE entry count=5.
    for (let i = 0; i < 5; i++) {
      const r = await fetch('/api/poll?n=' + i);
      await r.text();
    }
    document.getElementById('status').textContent = 'All fetches complete';
  }
  loadEverything();
</script>
</head>
<body>
  <h1>Probe Page Fixture</h1>
  <p id="status">Loading…</p>
</body></html>`;

function makeRichFixture() {
  return createServer((req, res) => {
    const url = req.url || '/';
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(FIXTURE_HTML);
    }
    if (url === '/api/products') return json(200, [{ id: 1, name: 'X' }]);
    if (url === '/api/users') return json(200, [{ id: 1 }]);
    if (url === '/api/missing') return json(404, { error: 'NotFound' });
    if (url === '/api/server-error') return json(500, { error: 'Boom' });
    if (url.startsWith('/api/poll')) return json(200, { polled: true });
    if (url === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      return res.end(Buffer.alloc(0));
    }
    res.writeHead(404);
    res.end('not found');
  });
}

export const flow = {
  name: 'probe-page',
  tags: ['probe', 'browser-public', 'browser-local', 'tunnel'],
  description: 'probe_page surface coverage: tool registered + single URL + rich-content aggregation + batch + pre-flight failure',
  async run({ client, step, assert, assertHas, writeArtifact }) {
    await step('tool registered: tools/list contains probe_page', async () => {
      const r = await client.request('tools/list', {}, 30_000);
      const names = (r.tools ?? []).map(t => t.name);
      assert(names.includes('probe_page'), `probe_page missing from roster. Got: ${names.join(', ')}`);
    });

    await step('single-target probe of public URL: returns under 30s with structured response', async () => {
      // Backend v2 (commit 154e1e69) browser.setup fixed-cost is ~20s per call;
      // budget reflects that until a session-reuse bead lands. Per-target
      // navigate+capture is sub-second so batches scale linearly from there.
      const t0 = Date.now();
      const r = await client.request('tools/call', {
        name: 'probe_page',
        arguments: { targets: [{ url: 'https://example.com' }] },
      }, 60_000);
      const elapsed = Date.now() - t0;
      await writeArtifact('public-single.json', r);
      assert(!r.isError, `tool error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      assert(elapsed < 30_000, `single-target probe took ${elapsed}ms; budget is 30s (browser.setup ~20s + navigate/capture)`);

      const body = JSON.parse(r.content[0].text);
      assertHas(body, 'executionId');
      assertHas(body, 'results');
      assert(body.results.length === 1, `expected 1 result, got ${body.results.length}`);
      const result = body.results[0];
      assert(result.url === 'https://example.com', `result.url mismatch: ${result.url}`);
      assert(typeof result.statusCode === 'number', `statusCode missing/non-numeric`);
      assert(Array.isArray(result.networkSummary), `networkSummary not an array`);
      assert(Array.isArray(result.consoleErrors), `consoleErrors not an array`);
    });

    let port;
    let server;
    try {
      server = makeRichFixture();
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      port = server.address().port;

      await step('localhost rich-content probe: networkSummary aggregates refetch loop to ONE row, count=5', async () => {
        const r = await client.request('tools/call', {
          name: 'probe_page',
          arguments: {
            targets: [{ url: `http://localhost:${port}`, waitForLoadState: 'networkidle', timeoutMs: 15000 }],
          },
        }, 30_000);
        await writeArtifact('localhost-rich.json', r);
        assert(!r.isError, `tool error: ${r.content?.[0]?.text?.slice(0, 300)}`);

        const body = JSON.parse(r.content[0].text);
        const result = body.results[0];

        // Refetch-loop check: /api/poll?n=0..4 should aggregate to one row, count=5.
        // Aggregation key per system reqs: origin + pathname. Query strings ignored.
        const pollEntry = result.networkSummary.find(e => e.url.endsWith('/api/poll'));
        assert(pollEntry, `networkSummary missing /api/poll aggregation. Entries: ${result.networkSummary.map(e => e.url).join(', ')}`);
        assert(pollEntry.count === 5, `expected count=5 for refetch loop, got ${pollEntry.count}`);

        // Different paths captured separately. Browser may fire the same
        // request more than once (preload + actual fetch); we verify the
        // path is present and produced AT LEAST ONE 200 / 404 of the
        // expected status — not exact request count, which is non-deterministic.
        const products = result.networkSummary.find(e => e.url.endsWith('/api/products'));
        const missing = result.networkSummary.find(e => e.url.endsWith('/api/missing'));
        assert(products && (products.statuses['200'] ?? 0) >= 1, `/api/products row missing or has no 200`);
        assert(missing && (missing.statuses['404'] ?? 0) >= 1, `/api/missing should show 404`);

        // Console capture — at least the deliberate warn + error
        const levels = new Set(result.consoleErrors.map(c => c.level));
        assert(levels.has('warning') || levels.has('warn'), `console warning not captured. Levels: ${[...levels].join(', ')}`);
        assert(levels.has('error'), `console error not captured. Levels: ${[...levels].join(', ')}`);
      });

      await step('5-target batch in ONE call: returns 5 results in input order, single executionId', async () => {
        const targets = ['/', '/api/products', '/api/users', '/api/missing', '/'].map(p => ({
          url: `http://localhost:${port}${p === '/' ? '' : p}`,
        }));
        const t0 = Date.now();
        const r = await client.request('tools/call', {
          name: 'probe_page',
          arguments: { targets, captureScreenshots: false },
        }, 90_000);
        const elapsed = Date.now() - t0;
        await writeArtifact('batch-5.json', r);
        assert(!r.isError, `batch tool error: ${r.content?.[0]?.text?.slice(0, 300)}`);
        // Browser.setup ~20s fixed; per-target navigate+capture ~0.5-1s.
        // 5-target batch budget = 20s setup + 5×1.5s per-target slack + 5s teardown = ~32s.
        // Padding to 45s for backend variability.
        assert(elapsed < 45_000, `5-target batch took ${elapsed}ms; budget is 45s (browser.setup + 5× navigate/capture)`);

        const body = JSON.parse(r.content[0].text);
        assert(body.results.length === 5, `expected 5 results, got ${body.results.length}`);
        // 1:1 mapping in input order
        for (let i = 0; i < 5; i++) {
          assert(
            body.results[i].url === targets[i].url,
            `results[${i}].url mismatch: expected ${targets[i].url}, got ${body.results[i].url}`,
          );
        }
        // Single executionId for the whole batch
        assert(typeof body.executionId === 'string' && body.executionId.length > 0,
          `batch must return a single executionId, got ${body.executionId}`);
        // captureScreenshots: false → no image blocks
        const images = (r.content ?? []).filter(b => b.type === 'image');
        assert(images.length === 0, `captureScreenshots: false should yield 0 image blocks, got ${images.length}`);
      });
    } finally {
      if (server) await new Promise(r => server.close(r));
    }

    await step('localhost dead port: returns LocalServerUnreachable in <2s', async () => {
      // Pick a port we just released by closing server, plus offset. There's a
      // small TOCTOU window but it's robust in practice.
      const deadPort = 1; // privileged port — guaranteed unbindable, ECONNREFUSED
      const t0 = Date.now();
      const r = await client.request('tools/call', {
        name: 'probe_page',
        arguments: { targets: [{ url: `http://localhost:${deadPort}` }] },
      }, 10_000);
      const elapsed = Date.now() - t0;
      assert(elapsed < 2000, `dead-port probe took ${elapsed}ms; pre-flight should fail in <2s`);
      assert(r.isError === true, `expected isError:true, got ${r.isError}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.error === 'LocalServerUnreachable',
        `expected error='LocalServerUnreachable', got '${body.error}'`);
    });
  },
};
