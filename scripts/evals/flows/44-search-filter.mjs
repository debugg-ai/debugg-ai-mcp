/**
 * Live search/filter: agent types into a search box and verifies the
 * list filters to ONLY the matching items — both that the matches appear
 * AND that the non-matches disappear.
 *
 * "The agent must verify something disappeared" is a subtly different
 * contract from "something appeared". A lazy read (just scan for the
 * expected text) would pass both cases. A thorough read must confirm
 * that unmatched items are NO LONGER visible after filtering.
 *
 * Fixture: 10-country list with a client-side search input that hides
 * non-matching items. Typing "United" should show 3 items (United
 * States, Kingdom, Arab Emirates) and hide the other 7.
 *
 * Tagged 'browser' + 'browser-local' + 'tunnel'. ~60s.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Country List</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 520px; }
    #search { width: 100%; padding: 10px; font-size: 16px; box-sizing: border-box; margin-bottom: 16px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: 10px 14px; border-bottom: 1px solid #e5e7eb; font-size: 15px; }
    li.hidden { display: none; }
    .empty { color: #6b7280; font-style: italic; padding: 16px; }
  </style>
</head>
<body>
  <h1>Countries</h1>
  <p>Search the list below.</p>
  <input type="text" id="search" placeholder="Search countries..." />
  <ul id="country-list">
    <li data-name="france">France</li>
    <li data-name="germany">Germany</li>
    <li data-name="italy">Italy</li>
    <li data-name="spain">Spain</li>
    <li data-name="united states">United States</li>
    <li data-name="united kingdom">United Kingdom</li>
    <li data-name="united arab emirates">United Arab Emirates</li>
    <li data-name="canada">Canada</li>
    <li data-name="australia">Australia</li>
    <li data-name="japan">Japan</li>
  </ul>

  <script>
    var input = document.getElementById('search');
    var items = document.querySelectorAll('#country-list li');
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      items.forEach(function (li) {
        var name = li.getAttribute('data-name');
        if (!q || name.indexOf(q) >= 0) {
          li.classList.remove('hidden');
        } else {
          li.classList.add('hidden');
        }
      });
    });
  </script>
</body>
</html>`;

export const flow = {
  name: 'search-filter',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent types into search box; asserts both appearance of matches AND disappearance of non-matches',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: country list search at ${url}\x1b[0m`);

    try {
      await step('type "United" in search → only 3 United-* countries visible, other 7 hidden', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a country list with a search input at the top. ' +
              'Type "United" into the search box. ' +
              'After typing, verify that the list shows exactly three countries: ' +
              '"United States", "United Kingdom", and "United Arab Emirates". ' +
              'Also verify that these countries are NO LONGER visible in the list: ' +
              'France, Germany, Italy, Spain, Canada, Australia, Japan. ' +
              'The filter is applied client-side, so results should update as you type.',
          },
        }, 360_000);

        await writeArtifact('search-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('search-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed search-filter. outcome='${body.outcome}', success=${body.success}. ` +
          `final intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        // Must have at least 2 actions (type + verify)
        assert(body.stepsTaken >= 2,
          `Expected stepsTaken >=2 (type + verify); got ${body.stepsTaken}`);

        await writeArtifact('action-trace.json', body.actionTrace ?? []);
        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
