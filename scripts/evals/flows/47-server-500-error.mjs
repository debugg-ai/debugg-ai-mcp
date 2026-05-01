/**
 * Real HTTP 500 error: agent must recognize a server-side failure and
 * report fail, not treat "a page rendered" as sufficient.
 *
 * Different from flow 42 (200+404-content) — this is an HONEST 500. The
 * server returns an error status with an error body. Naive browsers show
 * the body; naive agents might look past the status. A good agent notes
 * the error state and fails.
 *
 * Fixture: server always returns HTTP 500 with body "Internal Server
 * Error — please try again later".
 *
 * Description: claim the page should show a working dashboard.
 *
 * Expected: outcome=fail.
 *
 * ~30-60s wall time.
 */

import { createServer } from 'node:http';

const ERROR_BODY = `<!DOCTYPE html>
<html>
<head>
  <title>500 Internal Server Error</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 600px; text-align: center; }
    h1 { font-size: 72px; margin: 0; color: #dc2626; }
    h2 { color: #6b7280; margin-top: 0; }
    p { color: #4b5563; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>500</h1>
  <h2>Internal Server Error</h2>
  <p>Something went wrong on our end. Please try again later.</p>
  <p>If the problem persists, contact support.</p>
</body>
</html>`;

export const flow = {
  name: 'server-500-error',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Server returns real HTTP 500 with error body; agent must report fail when description asks for a working dashboard',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      // Honest 500 — real server error
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ERROR_BODY);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}/dashboard`;
    console.log(`  \x1b[2mfixture: 500-everywhere server at ${url}\x1b[0m`);

    try {
      await step('server returns 500; description claims working dashboard; agent reports fail', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is an analytics dashboard. ' +
              'It should display a welcome message "Welcome to your dashboard", three metric cards (Revenue, Users, Conversions), ' +
              'and a navigation sidebar. Verify the dashboard loads and displays these elements.',
          },
        }, 360_000);

        await writeArtifact('500-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('500-body.json', body);

        assert(body.outcome !== 'pass',
          `AGENT PASSED A 500 ERROR PAGE. Server returned HTTP 500 with body "Internal Server Error". ` +
          `Description asked about a dashboard. Got outcome='${body.outcome}'. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === false,
          `Expected success=false; got ${body.success}`);

        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
