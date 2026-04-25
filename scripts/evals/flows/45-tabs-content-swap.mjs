/**
 * Tabbed content navigation: agent clicks a tab and verifies the content
 * swap — old tab's content disappears, new tab's content appears.
 *
 * Same "disappearance" contract as flow 44, but through a discrete click
 * rather than live typing. Real apps (docs, settings panels, product
 * pages) use tabs constantly; if the agent can't verify a tab switch
 * correctly, it'll miss a large class of regressions.
 *
 * Fixture: 3 tabs (Overview, Pricing, FAQ), each with unique,
 * unambiguous content. Default is Overview. Agent must click Pricing
 * and verify Pricing-specific text ("$9/month", "Unlimited users")
 * appears AND Overview-specific text ("A modern tool for teams") is
 * no longer visible.
 *
 * ~50-80s wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Product Info</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 720px; }
    .tabs { display: flex; border-bottom: 2px solid #e5e7eb; }
    .tab { padding: 12px 20px; cursor: pointer; border: 0; background: none; font-size: 15px; color: #6b7280; }
    .tab.active { color: #2563eb; border-bottom: 2px solid #2563eb; margin-bottom: -2px; font-weight: 600; }
    .panel { padding: 24px 0; display: none; }
    .panel.active { display: block; }
    .panel h2 { margin-top: 0; }
    .feature { padding: 8px 0; font-size: 15px; }
  </style>
</head>
<body>
  <h1>Stellar Widget Pro</h1>

  <div class="tabs">
    <button class="tab active" data-target="panel-overview" id="tab-overview">Overview</button>
    <button class="tab" data-target="panel-pricing" id="tab-pricing">Pricing</button>
    <button class="tab" data-target="panel-faq" id="tab-faq">FAQ</button>
  </div>

  <div class="panel active" id="panel-overview">
    <h2>Product Overview</h2>
    <p>Stellar Widget Pro is a modern tool for teams who ship things that matter.</p>
    <div class="feature">• Real-time collaboration</div>
    <div class="feature">• End-to-end encryption</div>
    <div class="feature">• Open-source plugins</div>
  </div>

  <div class="panel" id="panel-pricing">
    <h2>Pricing Plans</h2>
    <p>Simple, transparent pricing. Cancel anytime.</p>
    <div class="feature">Starter: $9/month — up to 5 users</div>
    <div class="feature">Business: $49/month — Unlimited users</div>
    <div class="feature">Enterprise: Custom pricing</div>
  </div>

  <div class="panel" id="panel-faq">
    <h2>Frequently Asked Questions</h2>
    <p>Can't find what you're looking for? Contact support.</p>
    <div class="feature">Q: Is there a free trial? A: 14 days, no card required.</div>
    <div class="feature">Q: Can I switch plans? A: Yes, at any time.</div>
  </div>

  <script>
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
        tab.classList.add('active');
        document.getElementById(tab.getAttribute('data-target')).classList.add('active');
      });
    });
  </script>
</body>
</html>`;

export const flow = {
  name: 'tabs-content-swap',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent clicks Pricing tab; verifies Pricing-specific content appears AND Overview-specific content disappears',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: tabbed product page at ${url}\x1b[0m`);

    try {
      await step('click Pricing tab → Pricing content visible AND Overview content hidden', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a product info page with three tabs: Overview, Pricing, and FAQ. ' +
              'On page load, the Overview tab is active and shows text like "A modern tool for teams" and "Real-time collaboration". ' +
              'Click the "Pricing" tab. ' +
              'After clicking, verify: (1) the Pricing panel is now visible with text "Starter: $9/month" and "Business: $49/month — Unlimited users", ' +
              'AND (2) the Overview-specific text ("A modern tool for teams", "Real-time collaboration") is no longer visible.',
          },
        }, 360_000);

        await writeArtifact('tabs-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('tabs-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed tab swap. outcome='${body.outcome}'. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        // Must include a click + verify
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
