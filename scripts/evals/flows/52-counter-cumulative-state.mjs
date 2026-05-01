/**
 * Cumulative-state interaction: agent must perform a SPECIFIC number of
 * actions and verify the resulting cumulative state.
 *
 * Counter app starts at 0 with + and - buttons. Description: "click +
 * 7 times, click - 2 times, final value should be 5". The agent must:
 *   - Click + exactly 7 times (not 6, not 8 — losing count is a bug)
 *   - Click - exactly 2 times
 *   - Verify final value is 5
 *
 * Catches:
 *   - Off-by-one in click count
 *   - Agent giving up partway and reporting whatever it sees
 *   - Agent ignoring the arithmetic and rubber-stamping any visible number
 *
 * Hidden hint: 7 - 2 = 5 (description gives the answer). A non-arithmetic
 * agent could match the literal "5" against the displayed value without
 * actually doing the work — except that, on a fresh page, the displayed
 * value starts at 0 and only reaches 5 if the agent really clicked the
 * right sequence. So shortcuts don't help.
 *
 * ~60-120s wall time. Click-heavy.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Counter</title>
  <style>
    body { font-family: sans-serif; padding: 60px; max-width: 400px; text-align: center; }
    .display {
      font-size: 96px; font-weight: 700; color: #1f2937;
      padding: 30px; margin: 30px 0;
      background: #f3f4f6; border-radius: 12px;
    }
    .controls { display: flex; gap: 16px; justify-content: center; }
    button {
      width: 80px; height: 80px;
      font-size: 40px; font-weight: 600;
      border: 0; border-radius: 50%;
      cursor: pointer;
    }
    #plus { background: #2563eb; color: white; }
    #minus { background: #dc2626; color: white; }
  </style>
</head>
<body>
  <h1>Counter</h1>
  <p>Use the buttons below to increment or decrement.</p>
  <div class="display" id="value">0</div>
  <div class="controls">
    <button id="minus" type="button" aria-label="Decrement">−</button>
    <button id="plus" type="button" aria-label="Increment">+</button>
  </div>

  <script>
    var n = 0;
    var display = document.getElementById('value');
    document.getElementById('plus').addEventListener('click', function () {
      n += 1; display.textContent = String(n);
    });
    document.getElementById('minus').addEventListener('click', function () {
      n -= 1; display.textContent = String(n);
    });
  </script>
</body>
</html>`;

export const flow = {
  name: 'counter-cumulative-state',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent clicks + 7 times, − 2 times, verifies counter shows exactly 5',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: counter at ${url}\x1b[0m`);

    try {
      await step('click + 7 times, click − 2 times → counter displays 5', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a counter that starts at 0. There is a "+" button and a "−" (minus) button. ' +
              'Perform exactly the following sequence:\n' +
              '1. Click the "+" button 7 times.\n' +
              '2. Then click the "−" button 2 times.\n' +
              'After these clicks, verify that the counter display shows the number 5 ' +
              '(because 0 + 7 − 2 = 5). ' +
              'The test passes only if the displayed value is exactly 5.',
          },
        }, 360_000);

        await writeArtifact('counter-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('counter-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed counter math. outcome='${body.outcome}'. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        await writeArtifact('action-trace.json', body.actionTrace ?? []);
        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));

        console.log(`  \x1b[2magent stepsTaken=${body.stepsTaken}, durationMs=${body.durationMs}\x1b[0m`);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
