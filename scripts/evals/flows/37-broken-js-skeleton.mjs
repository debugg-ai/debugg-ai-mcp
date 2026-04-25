/**
 * Broken JS / stuck-skeleton page — the "HTTP 200 but the important part
 * never loaded" failure mode.
 *
 * Real-world trigger: a bundler drops a chunk, a CDN returns 304 on a
 * stale file, an uncaught TypeError in init code — the HTML envelope
 * loads fine, network shows 200s, but the user sees "Loading chart..."
 * indefinitely and the real content never materializes.
 *
 * A rubber-stamping or overly-lenient browser agent might see:
 *   - the page loaded (HTTP 200 ✓)
 *   - some content is visible ("Loading chart..." ✓)
 *   - no errors in the DOM view
 * ...and incorrectly report pass. A good agent should note that the
 * content DESCRIBED (a sales chart with Q1/Q2/Q3 data) is NOT visible,
 * only its placeholder.
 *
 * This flow's role in the suite: sister to flow 35 (form-truth-vs-lie)
 * on a different axis. 35 asks "can the agent spot a false claim about
 * a page that loaded correctly?". This asks "can the agent spot that the
 * page's content actually never rendered?"
 *
 * Tagged 'browser' + 'browser-local' + 'tunnel' — ~45-60s single call.
 */

import { createServer } from 'node:http';

// Fixture: HTML loads cleanly with HTTP 200. A <script> tries to call a
// global that doesn't exist, throws an uncaught ReferenceError, and the
// "Loading chart..." skeleton div is never replaced.
//
// The expected content (chart with Q1/Q2/Q3 bars) is REFERENCED in the
// description but never rendered on-screen. A well-behaved agent must
// report fail; a rubber-stamping one will pass.
const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Sales Dashboard</title>
  <style>
    body { font-family: sans-serif; padding: 40px; }
    #loading { color: #666; font-size: 18px; padding: 40px; background: #f3f4f6; border-radius: 8px; text-align: center; }
    #chart { display: none; width: 600px; height: 400px; border: 1px solid #ccc; }
  </style>
</head>
<body>
  <h1>Sales Dashboard</h1>
  <p>Quarterly revenue overview — data powered by Missing Charting Library.</p>
  <div id="chart-container">
    <div id="loading">Loading chart...</div>
    <canvas id="chart"></canvas>
  </div>
  <script>
    // Simulate a broken build / missing CDN chunk: reference a global that
    // doesn't exist. This throws ReferenceError synchronously and the
    // loading skeleton is never hidden, the chart never drawn.
    MissingChartingLibrary.render('#chart', [
      { quarter: 'Q1', revenue: 100 },
      { quarter: 'Q2', revenue: 150 },
      { quarter: 'Q3', revenue: 200 },
    ]);
    // These lines never run because the line above throws.
    document.getElementById('loading').style.display = 'none';
    document.getElementById('chart').style.display = 'block';
  </script>
</body>
</html>`;

export const flow = {
  name: 'broken-js-skeleton',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent reports fail when page HTML is 200-OK but JS throws and leaves a Loading skeleton in place of the promised content',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: broken-chart page at ${url}\x1b[0m`);

    try {
      await step('description promises a chart that never renders → outcome=fail, success=false', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page should display a sales dashboard with a chart that visualizes three quarters of revenue data: ' +
              'Q1 = $100, Q2 = $150, Q3 = $200. The chart should be rendered and visible. ' +
              'The page should NOT be stuck on a "Loading..." placeholder.',
          },
        }, 360_000);

        await writeArtifact('broken-js-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('broken-js-body.json', body);

        // The killer assertion: if the agent rubber-stamped based on
        // "HTTP 200 + some visible content", this fails.
        assert(body.outcome !== 'pass',
          `AGENT PASSED A PAGE THAT IS STUCK ON A LOADING SKELETON. ` +
          `The fixture has an uncaught ReferenceError; the chart never renders. ` +
          `Got outcome='${body.outcome}', success=${body.success}. ` +
          `actionTrace: ${JSON.stringify(body.actionTrace?.slice(-2) ?? []).slice(0, 500)}`);
        assert(body.success === false,
          `Expected success=false when the described chart never renders; got success=${body.success}`);

        // Soft signal that the agent actually observed the page's state
        // rather than erroring out before looking: actionTrace has at least
        // one step. Don't over-specify its content (agents vary phrasing).
        assert(Array.isArray(body.actionTrace) && body.actionTrace.length >= 1,
          `Expected agent to produce at least one actionTrace step; got ${body.actionTrace?.length}. ` +
          `If this is 0, the agent didn't actually run — something upstream is broken.`);

        // Log the intent text so we can eyeball whether the agent explained
        // the failure well (future-proofing; not asserting specific phrasing).
        const lastIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '(no intent)';
        await writeArtifact('agent-final-intent.txt', String(lastIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
