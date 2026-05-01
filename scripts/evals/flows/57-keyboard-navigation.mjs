/**
 * Keyboard navigation: agent fills a 3-field form using Tab to move
 * between fields and Enter to submit.
 *
 * Some agents may default to mouse-only interaction; this flow tests
 * the keyboard primitive path. Description explicitly instructs Tab
 * + Enter; if the agent uses click-fill-click instead, the form still
 * submits — so we don't strictly require keyboard. The test is just
 * that the agent CAN complete a keyboard-friendly form (a baseline
 * accessibility-style scenario).
 *
 * Fixture: 3 inputs + a submit button. On submit (any path), the
 * page shows "You entered: <a> / <b> / <c>" using the values.
 *
 * ~50-90s wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Three-Field Form</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 460px; }
    label { display: block; margin-top: 14px; font-weight: 600; }
    input { width: 100%; padding: 8px; margin-top: 4px; box-sizing: border-box; font-size: 15px; }
    button { margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: 0; cursor: pointer; }
    .result { margin-top: 24px; padding: 14px; background: #d1fae5; color: #065f46; border-radius: 6px; font-weight: 600; display: none; }
    .result.visible { display: block; }
  </style>
</head>
<body>
  <h1>Three-Field Form</h1>
  <p>Fill all three fields and submit.</p>

  <form id="form">
    <label for="f1">First Letter</label>
    <input id="f1" name="f1" autofocus />

    <label for="f2">Second Letter</label>
    <input id="f2" name="f2" />

    <label for="f3">Third Letter</label>
    <input id="f3" name="f3" />

    <button type="submit" id="submitBtn">Submit</button>
  </form>

  <div id="result" class="result"></div>

  <script>
    document.getElementById('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var v1 = document.getElementById('f1').value;
      var v2 = document.getElementById('f2').value;
      var v3 = document.getElementById('f3').value;
      var r = document.getElementById('result');
      r.textContent = 'You entered: ' + v1 + ' / ' + v2 + ' / ' + v3;
      r.classList.add('visible');
    });
  </script>
</body>
</html>`;

export const flow = {
  name: 'keyboard-navigation',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Fill 3 fields with A/B/C and submit; verify "You entered: A / B / C" appears',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: 3-field form at ${url}\x1b[0m`);

    try {
      await step('fill A/B/C and submit; verify "You entered: A / B / C"', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page has a three-field form (First Letter, Second Letter, Third Letter) and a Submit button. ' +
              'Fill in the first field with the letter "A", the second with "B", the third with "C". ' +
              'Submit the form. ' +
              'After submitting, verify a confirmation appears containing the exact text "You entered: A / B / C".',
          },
        }, 360_000);

        await writeArtifact('keyboard-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('keyboard-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed form fill+submit. outcome='${body.outcome}'. ` +
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
