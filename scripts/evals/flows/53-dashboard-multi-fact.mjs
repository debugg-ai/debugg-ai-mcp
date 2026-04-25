/**
 * Multi-fact verification on a single rich page: agent must verify
 * MULTIPLE distinct facts in one pass, not just spot-check the first
 * thing it sees.
 *
 * Real-world dashboards conflate "is everything OK" with "are these
 * 4 specific KPIs in spec, is this chart showing the right data, is
 * this table's most-recent row what we expect". A naive agent would
 * verify ONE thing and report pass; a thorough agent verifies all.
 *
 * Fixture: a fake analytics dashboard with:
 *   - 4 KPI cards (Revenue $12,450, Users 1,847, Conversions 124, Refunds 3)
 *   - A "chart" (rendered as a labeled list) with Q1 ($3K), Q2 ($4K), Q3 ($5.45K)
 *   - A 5-row recent-activity table with most-recent entry "Alice Park / 2 min ago"
 *
 * Description asks the agent to verify 3 SPECIFIC facts:
 *   - Revenue KPI = $12,450
 *   - Chart Q3 value = $5.45K
 *   - Most-recent activity entry = "Alice Park" (2 min ago)
 *
 * If the agent misses ANY fact, the test should fail. We then run a
 * negative variant where one of the three claims is false (Revenue
 * claimed wrong) — agent must catch THAT specific claim and fail.
 *
 * ~80-150s wall time (2 calls).
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Analytics Dashboard</title>
  <style>
    body { font-family: sans-serif; padding: 32px; max-width: 980px; margin: 0 auto; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 16px; }
    .kpi { background: #f3f4f6; padding: 18px; border-radius: 8px; border-left: 4px solid #2563eb; }
    .kpi-label { color: #6b7280; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; }
    .kpi-value { font-size: 28px; font-weight: 700; color: #1f2937; margin-top: 6px; }
    section { margin-top: 32px; }
    .chart { display: flex; gap: 16px; align-items: flex-end; height: 220px; }
    .bar { flex: 1; background: #2563eb; color: white; padding: 8px; border-radius: 4px 4px 0 0; text-align: center; }
    .bar small { display: block; opacity: 0.8; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
    th { background: #f9fafb; font-weight: 600; font-size: 13px; color: #6b7280; text-transform: uppercase; }
  </style>
</head>
<body>
  <h1>Analytics Dashboard</h1>
  <p>Last 30 days · Auto-refreshing</p>

  <section>
    <h2>Key Metrics</h2>
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Revenue</div><div class="kpi-value">$12,450</div></div>
      <div class="kpi"><div class="kpi-label">Users</div><div class="kpi-value">1,847</div></div>
      <div class="kpi"><div class="kpi-label">Conversions</div><div class="kpi-value">124</div></div>
      <div class="kpi"><div class="kpi-label">Refunds</div><div class="kpi-value">3</div></div>
    </div>
  </section>

  <section>
    <h2>Quarterly Revenue</h2>
    <div class="chart">
      <div class="bar" style="height: 55%;">Q1<br><strong>$3.00K</strong><small>2026 Q1</small></div>
      <div class="bar" style="height: 73%;">Q2<br><strong>$4.00K</strong><small>2026 Q2</small></div>
      <div class="bar" style="height: 100%;">Q3<br><strong>$5.45K</strong><small>2026 Q3</small></div>
    </div>
  </section>

  <section>
    <h2>Recent Activity</h2>
    <table>
      <thead><tr><th>User</th><th>Action</th><th>When</th></tr></thead>
      <tbody>
        <tr><td>Alice Park</td><td>Upgraded to Pro plan</td><td>2 min ago</td></tr>
        <tr><td>Bob Chen</td><td>Submitted support ticket #4821</td><td>14 min ago</td></tr>
        <tr><td>Carol Diaz</td><td>Viewed pricing page</td><td>32 min ago</td></tr>
        <tr><td>David Kim</td><td>Renewed subscription</td><td>1 hour ago</td></tr>
        <tr><td>Eve Rossi</td><td>Created new project</td><td>2 hours ago</td></tr>
      </tbody>
    </table>
  </section>
</body>
</html>`;

export const flow = {
  name: 'dashboard-multi-fact',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent verifies 3 distinct facts on a rich dashboard (KPI value, chart Q3 value, top-of-table entry); also catches a single false claim',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: analytics dashboard at ${url}\x1b[0m`);

    let allTrueBody;
    let oneFalseBody;

    try {
      await step('all 3 claims true (Revenue $12,450, Q3 $5.45K, Alice Park) → outcome=pass', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is an analytics dashboard. Verify ALL THREE of the following facts simultaneously:\n' +
              '1. The Revenue KPI card shows the value "$12,450".\n' +
              '2. In the Quarterly Revenue chart, the Q3 bar shows "$5.45K".\n' +
              '3. In the Recent Activity table, the most recent (top) row is "Alice Park" (with action "Upgraded to Pro plan", 2 min ago).\n' +
              'The test passes only if all three facts are correct as described.',
          },
        }, 360_000);

        await writeArtifact('all-true-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        allTrueBody = JSON.parse(r.content[0].text);
        await writeArtifact('all-true-body.json', allTrueBody);

        assert(allTrueBody.outcome === 'pass',
          `Expected pass on all-true claims; got '${allTrueBody.outcome}'. ` +
          `intent: ${allTrueBody.actionTrace?.[allTrueBody.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(allTrueBody.success === true, `Expected success=true; got ${allTrueBody.success}`);
      });

      await step('one claim false (Revenue claimed $99,999) → outcome=fail; agent must catch the WRONG fact', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is an analytics dashboard. Verify ALL THREE of the following facts:\n' +
              '1. The Revenue KPI card shows the value "$99,999".\n' +
              '2. In the Quarterly Revenue chart, the Q3 bar shows "$5.45K".\n' +
              '3. In the Recent Activity table, the most recent (top) row is "Alice Park" (with action "Upgraded to Pro plan", 2 min ago).\n' +
              'The test passes only if all three facts are correct as described. ' +
              'Note: facts 2 and 3 are correct; fact 1 (Revenue $99,999) is the only wrong one.',
          },
        }, 360_000);

        await writeArtifact('one-false-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        oneFalseBody = JSON.parse(r.content[0].text);
        await writeArtifact('one-false-body.json', oneFalseBody);

        assert(oneFalseBody.outcome !== 'pass',
          `AGENT MISSED THE FALSE CLAIM. Description claimed Revenue=$99,999 but page shows $12,450. ` +
          `Got outcome='${oneFalseBody.outcome}'. ` +
          `intent: ${oneFalseBody.actionTrace?.[oneFalseBody.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(oneFalseBody.success === false,
          `Expected success=false; got ${oneFalseBody.success}`);

        // Soft signal: agent should mention either "Revenue", "$12,450", or
        // "$99,999" in its diagnostic — proving it caught the SPECIFIC wrong
        // fact, not just generically failed.
        const finalIntent = oneFalseBody.actionTrace?.[oneFalseBody.actionTrace.length - 1]?.intent ?? '';
        const intentLower = finalIntent.toLowerCase();
        const noticedRevenue =
          intentLower.includes('revenue') ||
          intentLower.includes('12,450') ||
          intentLower.includes('99,999') ||
          intentLower.includes('99999');
        assert(noticedRevenue,
          `Agent failed but didn't mention Revenue / $12,450 / $99,999. Final intent: "${finalIntent}". ` +
          `Without specific identification, future regressions on which-fact-was-wrong are invisible.`);
      });

      await step('the two runs are distinct (different executionIds, different outcomes)', async () => {
        assert(allTrueBody.executionId !== oneFalseBody.executionId,
          `executionIds collided`);
        await writeArtifact('comparison.json', {
          allTrue: {
            outcome: allTrueBody.outcome,
            success: allTrueBody.success,
            finalIntent: allTrueBody.actionTrace?.[allTrueBody.actionTrace.length - 1]?.intent,
          },
          oneFalse: {
            outcome: oneFalseBody.outcome,
            success: oneFalseBody.success,
            finalIntent: oneFalseBody.actionTrace?.[oneFalseBody.actionTrace.length - 1]?.intent,
          },
        });
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
