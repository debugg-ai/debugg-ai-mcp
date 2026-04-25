/**
 * Autocomplete dropdown: type to filter → click suggestion → verify
 * confirmed selection appears.
 *
 * Common typeahead pattern from real apps (search bars, tag pickers,
 * country selectors). Three primitives in sequence: fill an input,
 * click a dynamically-rendered suggestion item, observe state change.
 *
 * Fixture: a fruit picker. Type 'app' → suggestions filter to "Apple"
 * and "Apricot". Click "Apple" → confirmed-selection area shows
 * "Selected: Apple".
 *
 * ~50-90s wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Fruit Picker</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 460px; }
    .picker { position: relative; }
    input { width: 100%; padding: 10px; font-size: 15px; box-sizing: border-box; }
    .suggestions {
      position: absolute; top: 100%; left: 0; right: 0;
      background: white; border: 1px solid #d1d5db; border-top: 0;
      max-height: 200px; overflow: auto;
    }
    .suggestions.hidden { display: none; }
    .suggestion {
      padding: 10px 14px; cursor: pointer;
    }
    .suggestion:hover { background: #eff6ff; }
    .selection {
      margin-top: 30px; padding: 16px;
      background: #f3f4f6; border-radius: 6px;
      font-size: 16px;
    }
    .selection.empty { color: #6b7280; font-style: italic; }
    .selection.set { background: #d1fae5; color: #065f46; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Pick a Fruit</h1>
  <p>Start typing to see suggestions.</p>

  <div class="picker">
    <input type="text" id="input" placeholder="e.g., apple, banana..." autocomplete="off" />
    <div id="suggestions" class="suggestions hidden"></div>
  </div>

  <div class="selection empty" id="selection">No fruit selected yet.</div>

  <script>
    var FRUITS = ['Apple', 'Apricot', 'Avocado', 'Banana', 'Blackberry', 'Blueberry', 'Cherry', 'Coconut', 'Date', 'Fig', 'Grape', 'Lemon', 'Mango', 'Orange', 'Pear', 'Pineapple', 'Strawberry'];
    var input = document.getElementById('input');
    var sugBox = document.getElementById('suggestions');
    var selection = document.getElementById('selection');

    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      if (!q) { sugBox.classList.add('hidden'); sugBox.innerHTML = ''; return; }
      var matches = FRUITS.filter(function (f) { return f.toLowerCase().startsWith(q); });
      if (matches.length === 0) { sugBox.classList.add('hidden'); sugBox.innerHTML = ''; return; }
      sugBox.classList.remove('hidden');
      sugBox.innerHTML = matches.map(function (m) {
        return '<div class="suggestion" data-name="' + m + '">' + m + '</div>';
      }).join('');
      sugBox.querySelectorAll('.suggestion').forEach(function (s) {
        s.addEventListener('click', function () {
          var name = s.getAttribute('data-name');
          input.value = name;
          sugBox.classList.add('hidden');
          sugBox.innerHTML = '';
          selection.className = 'selection set';
          selection.textContent = 'Selected: ' + name;
        });
      });
    });
  </script>
</body>
</html>`;

export const flow = {
  name: 'autocomplete-dropdown',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Type "app" → 2 suggestions filtered → click Apple → confirmed-selection area shows "Selected: Apple"',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: fruit autocomplete at ${url}\x1b[0m`);

    try {
      await step('type "app" → click "Apple" suggestion → "Selected: Apple" appears', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a fruit picker with autocomplete. ' +
              'Type "app" into the search input. ' +
              'A dropdown of suggestions should appear (the matching fruits start with "app"). ' +
              'Click the "Apple" suggestion in the dropdown. ' +
              'After clicking, verify the confirmed selection area shows "Selected: Apple".',
          },
        }, 360_000);

        await writeArtifact('autocomplete-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('autocomplete-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed autocomplete. outcome='${body.outcome}'. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
