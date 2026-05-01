/**
 * Pagination: agent clicks Next and verifies page 2 content replaced
 * page 1 content.
 *
 * Common real-app pattern. The failure mode this catches: an agent that
 * rubber-stamps based on "a list is visible" without actually checking
 * the SPECIFIC items present. If it lands on page 1 and the description
 * mentions page-2 items, a lazy agent would still pass.
 *
 * Fixture: 30 items rendered 10-per-page. "Next" advances one page;
 * current page and item range are updated. Items have distinct,
 * unambiguous names (Item 01 ... Item 30).
 *
 * Description: "click Next, verify Item 11 .. Item 20 are visible and
 * Item 01 .. Item 10 are NOT visible."
 *
 * ~60-90s wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Items</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 600px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: 10px 14px; border-bottom: 1px solid #e5e7eb; font-size: 15px; }
    .controls { margin-top: 20px; display: flex; align-items: center; gap: 12px; }
    button { padding: 8px 14px; background: #2563eb; color: white; border: 0; cursor: pointer; border-radius: 4px; }
    button:disabled { background: #9ca3af; cursor: not-allowed; }
    .status { color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <h1>Items</h1>
  <p class="status"><span id="range"></span></p>
  <ul id="list"></ul>
  <div class="controls">
    <button id="prev" type="button">Previous</button>
    <button id="next" type="button">Next</button>
    <span class="status" id="pageInfo"></span>
  </div>

  <script>
    var PAGE_SIZE = 10;
    var TOTAL = 30;
    var page = 1;
    function render() {
      var list = document.getElementById('list');
      list.innerHTML = '';
      var start = (page - 1) * PAGE_SIZE + 1;
      var end = Math.min(page * PAGE_SIZE, TOTAL);
      for (var i = start; i <= end; i++) {
        var li = document.createElement('li');
        li.textContent = 'Item ' + String(i).padStart(2, '0');
        list.appendChild(li);
      }
      document.getElementById('range').textContent = 'Showing items ' + start + '–' + end + ' of ' + TOTAL;
      document.getElementById('pageInfo').textContent = 'Page ' + page + ' of ' + Math.ceil(TOTAL / PAGE_SIZE);
      document.getElementById('prev').disabled = page === 1;
      document.getElementById('next').disabled = page === Math.ceil(TOTAL / PAGE_SIZE);
    }
    document.getElementById('next').addEventListener('click', function () { page++; render(); });
    document.getElementById('prev').addEventListener('click', function () { page--; render(); });
    render();
  </script>
</body>
</html>`;

export const flow = {
  name: 'pagination-next-page',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent clicks Next, verifies page 2 items (Item 11-20) appear AND page 1 items (Item 01-10) disappear',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: paginated list at ${url}\x1b[0m`);

    try {
      await step('click Next → page 2 items (11-20) visible, page 1 items (01-10) hidden', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a paginated list. On load, it shows page 1 with Item 01 through Item 10. ' +
              'Click the "Next" button to advance to page 2. ' +
              'After clicking Next, verify: ' +
              '(1) Item 11 and Item 20 are visible in the list (page 2 content). ' +
              '(2) Item 01 and Item 10 are NO LONGER visible (page 1 content has been replaced). ' +
              '(3) The page indicator shows "Page 2 of 3".',
          },
        }, 360_000);

        await writeArtifact('pagination-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('pagination-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed pagination. outcome='${body.outcome}'. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        assert(body.stepsTaken >= 2,
          `Expected stepsTaken >=2; got ${body.stepsTaken}`);

        await writeArtifact('action-trace.json', body.actionTrace ?? []);
        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
