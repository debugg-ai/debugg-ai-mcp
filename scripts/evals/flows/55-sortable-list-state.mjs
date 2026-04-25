/**
 * Sortable list state-change: agent clicks a column header and verifies
 * the row order changes accordingly.
 *
 * Default sort is by Date (most recent first). Default row order:
 *   Carol Diaz (3 days ago) — row 1
 *   Alice Park (5 days ago) — row 2
 *   David Kim (7 days ago) — row 3
 *   Eve Rossi (12 days ago) — row 4
 *   Bob Chen (20 days ago) — row 5
 *
 * After clicking "Name" header, alphabetical:
 *   Alice Park — row 1
 *   Bob Chen — row 2
 *   Carol Diaz — row 3
 *   David Kim — row 4
 *   Eve Rossi — row 5
 *
 * The "Alice in row 1, Eve in row 5" change is meaningful BECAUSE the
 * default order had Carol first and Bob last. A rubber-stamping agent
 * that doesn't actually click would see Carol-first ordering and would
 * have to lie about Alice being first.
 *
 * ~60-90s wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Sortable List</title>
  <style>
    body { font-family: sans-serif; padding: 32px; max-width: 700px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f3f4f6; padding: 12px 14px; text-align: left; font-weight: 600; cursor: pointer; user-select: none; border-bottom: 2px solid #e5e7eb; }
    th:hover { background: #e5e7eb; }
    th.sorted::after { content: " ↑"; color: #2563eb; }
    td { padding: 10px 14px; border-bottom: 1px solid #e5e7eb; }
    .hint { color: #6b7280; font-size: 14px; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Recent Logins</h1>
  <p class="hint">Click any column header to sort.</p>

  <table id="data">
    <thead>
      <tr>
        <th data-key="name">Name</th>
        <th data-key="date" class="sorted">Date</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>

  <script>
    var rows = [
      { name: 'Carol Diaz', daysAgo: 3 },
      { name: 'Alice Park', daysAgo: 5 },
      { name: 'David Kim',  daysAgo: 7 },
      { name: 'Eve Rossi',  daysAgo: 12 },
      { name: 'Bob Chen',   daysAgo: 20 },
    ];
    var sortKey = 'date';

    function render() {
      var tbody = document.getElementById('tbody');
      var sorted = rows.slice().sort(function (a, b) {
        if (sortKey === 'name') return a.name.localeCompare(b.name);
        return a.daysAgo - b.daysAgo; // ascending — most recent first
      });
      tbody.innerHTML = sorted.map(function (r) {
        return '<tr><td>' + r.name + '</td><td>' + r.daysAgo + ' days ago</td></tr>';
      }).join('');
      document.querySelectorAll('th').forEach(function (th) {
        th.classList.toggle('sorted', th.getAttribute('data-key') === sortKey);
      });
    }
    document.querySelectorAll('th').forEach(function (th) {
      th.addEventListener('click', function () {
        sortKey = th.getAttribute('data-key');
        render();
      });
    });
    render();
  </script>
</body>
</html>`;

export const flow = {
  name: 'sortable-list-state',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Click Name column header → table re-sorts alphabetically; agent verifies Alice is now row 1 and Eve is last row',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: sortable table at ${url}\x1b[0m`);

    try {
      await step('click Name header → row order becomes Alice, Bob, Carol, David, Eve (alphabetical)', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a sortable table of recent logins. ' +
              'Click the "Name" column header to sort the table alphabetically. ' +
              'After clicking, verify that "Alice Park" is now the first (top) row of the table ' +
              'and "Eve Rossi" is the last (bottom) row of the table.',
          },
        }, 360_000);

        await writeArtifact('sortable-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('sortable-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed sort verification. outcome='${body.outcome}'. ` +
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
