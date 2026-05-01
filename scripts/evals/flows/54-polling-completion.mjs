/**
 * Sustained polling: agent must watch a status page that updates every
 * 1s and wait for it to reach "Complete" — about 10s of cumulative
 * waiting.
 *
 * Companion to flow 39 (single 2.5s delay). This is harder because:
 *   - The status changes over time (not a one-shot wait)
 *   - The agent must distinguish intermediate states ("Processing 30%")
 *     from the terminal state ("Complete 100%")
 *   - Reporting too early (e.g., on "Processing 50%") would be wrong
 *
 * Fixture: header shows "Status: <state>" and a progress bar updating
 * from 0% → 100% in 10 increments of ~1s each. At 100% the status text
 * changes to "Status: Complete".
 *
 * If agent passes too early, it'd see "Processing" and the description
 * says "Complete" — should fail.
 * If agent passes correctly, it waits ~10s, sees "Complete", → pass.
 *
 * ~30-90s wall time depending on agent's polling cadence.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Job Status</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 540px; }
    .status { font-size: 22px; font-weight: 600; padding: 16px 20px; border-radius: 8px; margin-top: 16px; }
    .status.processing { background: #fef3c7; color: #92400e; border-left: 4px solid #d97706; }
    .status.complete   { background: #d1fae5; color: #065f46; border-left: 4px solid #059669; }
    .progress-bar { background: #e5e7eb; border-radius: 999px; height: 24px; margin-top: 16px; overflow: hidden; }
    .progress-fill { height: 100%; background: #2563eb; transition: width 600ms ease; display: flex; align-items: center; justify-content: center; color: white; font-size: 13px; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Background Job</h1>
  <p>This page polls the job status until completion.</p>

  <div id="status" class="status processing">Status: Processing</div>
  <div class="progress-bar"><div id="fill" class="progress-fill" style="width: 0%;">0%</div></div>

  <script>
    var pct = 0;
    var statusEl = document.getElementById('status');
    var fillEl = document.getElementById('fill');
    var interval = setInterval(function () {
      pct += 10;
      if (pct >= 100) {
        pct = 100;
        clearInterval(interval);
        statusEl.className = 'status complete';
        statusEl.textContent = 'Status: Complete';
      }
      fillEl.style.width = pct + '%';
      fillEl.textContent = pct + '%';
    }, 1000);
  </script>
</body>
</html>`;

export const flow = {
  name: 'polling-completion',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Status page polls every 1s, completes after ~10s. Agent must wait for terminal Complete state, not pass on intermediate Processing.',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: 10s polling job at ${url}\x1b[0m`);

    try {
      await step('agent waits ~10s for status to reach Complete + 100%', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page shows a background job status that updates every second. ' +
              'On load, the status starts as "Status: Processing" with progress 0%. ' +
              'The status will gradually update over about 10 seconds and eventually reach 100% complete. ' +
              'WAIT for the job to finish, then verify: ' +
              '(1) the status text reads "Status: Complete" (NOT "Status: Processing"), ' +
              'and (2) the progress bar shows "100%". ' +
              'Do NOT report success while the status is still "Processing". ' +
              'Wait until completion before judging.',
          },
        }, 360_000);

        await writeArtifact('polling-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('polling-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed polling-completion. outcome='${body.outcome}'. ` +
          `If 'fail', most likely cause: agent reported too early on "Processing" instead of waiting. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        // The job takes ~10s. If durationMs is much less than 10s, agent
        // didn't actually wait — it would have seen "Processing" or
        // intermediate state. The eval still passed only because the agent
        // happened to verify after waiting. We assert >5s as a soft floor
        // that tolerates fast networks but catches obviously-too-fast runs.
        assert(body.durationMs > 5000,
          `durationMs=${body.durationMs} is suspiciously fast for a 10s job. ` +
          `Agent may have evaluated before completion.`);

        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));

        // Soft signal: intent should mention complete/100 to prove agent
        // saw the terminal state, not just any state
        const intentLower = finalIntent.toLowerCase();
        const sawCompleted =
          intentLower.includes('complete') ||
          intentLower.includes('100');
        assert(sawCompleted,
          `Agent passed but intent doesn't mention "complete" or "100": "${finalIntent}". ` +
          `Test may be passing by luck.`);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
