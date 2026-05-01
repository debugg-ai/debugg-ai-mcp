/**
 * Infinite scroll: agent must scroll to trigger lazy-loading of items
 * that only appear after the initial batch.
 *
 * Real apps (feeds, search results, message lists) lazy-load content
 * as the user scrolls. The target item ("Item 32") only appears after
 * the user scrolls near the end of the first batch (1-20), which
 * triggers the second batch (21-40) to load with a 1.2s simulated
 * network delay.
 *
 * Combines: scroll + intersection-detection + wait + verification.
 *
 * Companion to flow 49 (scroll-to-find static long page) — that flow
 * just scrolled. This one scrolls AND triggers async loads, then
 * verifies content from the second batch.
 *
 * ~60-120s wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Infinite Feed</title>
  <style>
    body { font-family: sans-serif; padding: 32px; max-width: 600px; margin: 0 auto; }
    .item { padding: 14px 18px; margin: 10px 0; background: #f3f4f6; border-radius: 6px; font-size: 16px; }
    #sentinel { height: 1px; }
    #loader { padding: 14px; text-align: center; color: #6b7280; font-style: italic; }
    #loader.hidden { display: none; }
  </style>
</head>
<body>
  <h1>Infinite Feed</h1>
  <p>Scroll down to load more items.</p>
  <div id="list"></div>
  <div id="loader" class="hidden">Loading more…</div>
  <div id="sentinel"></div>

  <script>
    var TOTAL = 40;
    var BATCH = 20;
    var loaded = 0;
    var loading = false;
    var list = document.getElementById('list');
    var loader = document.getElementById('loader');

    function loadBatch() {
      if (loading || loaded >= TOTAL) return;
      loading = true;
      loader.classList.remove('hidden');
      // Simulated network delay
      setTimeout(function () {
        var end = Math.min(loaded + BATCH, TOTAL);
        for (var i = loaded + 1; i <= end; i++) {
          var div = document.createElement('div');
          div.className = 'item';
          div.textContent = 'Item ' + i;
          list.appendChild(div);
        }
        loaded = end;
        loader.classList.add('hidden');
        loading = false;
      }, 1200);
    }

    // Initial batch
    loadBatch();

    // Trigger second batch when sentinel scrolls into view
    var io = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && loaded < TOTAL) {
        loadBatch();
      }
    });
    io.observe(document.getElementById('sentinel'));
  </script>
</body>
</html>`;

export const flow = {
  name: 'infinite-scroll',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Initial batch shows Items 1-20; scrolling triggers lazy-load of Items 21-40. Agent must scroll, wait for load, find Item 32.',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: infinite scroll feed at ${url}\x1b[0m`);

    try {
      await step('scroll to load second batch, find "Item 32" (only present after second batch loads)', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is an infinite-scroll feed. ' +
              'Initially only Items 1-20 are loaded. ' +
              'Scroll down to the bottom of the list — when you reach the end, more items will load (Items 21-40). ' +
              'Wait for the "Loading more…" indicator to disappear (about 1-2 seconds). ' +
              'Then verify that "Item 32" is now visible in the list. ' +
              'Item 32 only exists after the second batch loads, so this requires scrolling first.',
          },
        }, 360_000);

        await writeArtifact('infinite-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('infinite-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed infinite scroll. outcome='${body.outcome}'. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        await writeArtifact('action-trace.json', body.actionTrace ?? []);
        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
