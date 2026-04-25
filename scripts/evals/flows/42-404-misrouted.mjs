/**
 * SPA 404 misroute: HTTP 200 + "Page Not Found" content should NOT pass
 * an agent check for the product page that was supposedly there.
 *
 * Real-world trigger: a SPA with client-side routing catches unknown
 * routes and renders a 404 component. The HTTP layer is still 200. A
 * naive agent (or one that relies on HTTP status codes for health)
 * might treat this as a successful page load and rubber-stamp.
 *
 * A good agent reads the rendered content and notes: "this is a 404
 * page, not the product detail page I was asked to verify."
 *
 * Fixture: every URL returns HTTP 200 + a 404 content page with the
 * heading "Page Not Found" and a link back to home. No product UI
 * anywhere.
 *
 * Description: "verify the Wireless Headphones product detail page
 * with price and Add to Cart button."
 *
 * Expected: outcome=fail.
 *
 * ~30-45s wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>404 - Page Not Found</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 600px; text-align: center; }
    h1 { font-size: 72px; margin: 0; color: #dc2626; }
    h2 { color: #6b7280; margin-top: 0; }
    p { color: #4b5563; line-height: 1.5; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>404</h1>
  <h2>Page Not Found</h2>
  <p>Sorry, we couldn't find the page you were looking for. It may have been moved or doesn't exist.</p>
  <p><a href="/">Return to home</a></p>
</body>
</html>`;

export const flow = {
  name: '404-misrouted',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Server returns HTTP 200 with a "Page Not Found" body. Agent must recognize the 404 content and report fail, not pass on HTTP 200.',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      // Intentional: 200, not 404 — this is the SPA-routing failure
      // mode where the HTTP envelope is fine but the content is a
      // not-found page.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    // Hit a sub-path that doesn't exist in the fixture's mental model —
    // the URL looks like a real product page but the server returns 404
    // content for everything.
    const url = `http://localhost:${port}/product/wireless-headphones`;
    console.log(`  \x1b[2mfixture: 404-everywhere server at ${url}\x1b[0m`);

    try {
      await step('description claims product page; server shows 404 body; agent reports fail', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a product detail page for "Wireless Headphones". ' +
              'It should display the product name, its price, an image, and an "Add to Cart" button. ' +
              'Verify the product page renders correctly.',
          },
        }, 360_000);

        await writeArtifact('misrouted-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('misrouted-body.json', body);

        // Killer assertion: a SPA-404 is the classic "HTTP says 200 so
        // everything's fine" rubber-stamp failure. Agent must read content.
        assert(body.outcome !== 'pass',
          `AGENT RUBBER-STAMPED A 404 PAGE. ` +
          `Server returns 200 with body heading "Page Not Found"; description asks about a product page. ` +
          `Got outcome='${body.outcome}', success=${body.success}. ` +
          `This is the class of bug where SPAs silently misroute and no one notices. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === false,
          `Expected success=false; got ${body.success}`);

        // Sanity: agent actually looked at the page
        assert(Array.isArray(body.actionTrace) && body.actionTrace.length >= 1,
          `Expected at least one actionTrace step`);

        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
