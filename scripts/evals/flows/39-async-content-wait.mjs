/**
 * Async-render patience: agent must wait for delayed content to appear
 * before judging.
 *
 * Real apps often render a skeleton, fire an XHR, and only populate the
 * page ~1-3s later. An impatient agent that evaluates immediately would
 * see the skeleton and report fail — giving a false negative on a working
 * page. A rubber-stamping agent would report pass regardless.
 *
 * Fixture: page loads with "Loading..." placeholder, then after 2s a
 * setTimeout replaces it with concrete revenue data (Q1/Q2/Q3 text).
 *
 * Companion to flow 37 (broken-js-skeleton) — same basic shape, but the
 * content DOES eventually render. If flow 37 passes (skeleton stuck →
 * fail) AND this flow passes (skeleton briefly → wait → pass), the
 * agent's patience is well-calibrated.
 *
 * ~45-60s wall time, single browser run.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Revenue Dashboard</title>
  <style>
    body { font-family: sans-serif; padding: 40px; }
    #loading { color: #666; padding: 20px; background: #f3f4f6; border-radius: 8px; }
    #data { display: none; }
    .metric { padding: 10px 14px; margin: 6px 0; background: #eff6ff; border-left: 4px solid #2563eb; font-size: 18px; }
    .label { font-weight: 600; color: #1e3a8a; }
  </style>
</head>
<body>
  <h1>Revenue Dashboard</h1>
  <div id="loading">Loading revenue data...</div>
  <div id="data">
    <h2>Quarterly Revenue</h2>
    <div class="metric"><span class="label">Q1:</span> $100</div>
    <div class="metric"><span class="label">Q2:</span> $150</div>
    <div class="metric"><span class="label">Q3:</span> $200</div>
  </div>
  <script>
    // Simulate an XHR that resolves after 2.5s — long enough that an
    // impatient agent might give up, short enough that a reasonable
    // agent waits through it.
    setTimeout(function () {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('data').style.display = 'block';
    }, 2500);
  </script>
</body>
</html>`;

export const flow = {
  name: 'async-content-wait',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent waits for 2.5s-delayed content to render before judging — passes on data that appears, would pass-too-early or fail-too-early without patience',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: delayed-render page at ${url} (2.5s delay before content)\x1b[0m`);

    try {
      await step('page loads with skeleton, content renders after 2.5s → agent waits and reports pass on delayed content', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a Revenue Dashboard that loads data asynchronously. ' +
              'After the page finishes loading, it should display three quarterly revenue metrics: ' +
              'Q1 = $100, Q2 = $150, Q3 = $200. ' +
              'The content may appear after a short delay (wait for it to load).',
          },
        }, 360_000);

        await writeArtifact('async-wait-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('async-wait-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed to wait for delayed content. ` +
          `Fixture renders Q1/Q2/Q3 data after 2.5s; agent got outcome='${body.outcome}'. ` +
          `Either it evaluated too early (and saw only the Loading skeleton) ` +
          `or the description/assertion wording confused it. ` +
          `final intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true,
          `Expected success=true; got ${body.success}`);

        // Sanity: real browser work happened. Eval should take several
        // seconds — if it's sub-second, the agent didn't actually wait
        // for the delayed content.
        assert(body.durationMs > 3000,
          `Evaluation took only ${body.durationMs}ms — less than the 2.5s render delay. ` +
          `Agent almost certainly didn't wait; this may have passed by coincidence.`);

        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
