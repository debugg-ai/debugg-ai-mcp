/**
 * Proves the tunnel forwards deep-path localhost URLs correctly on first navigation.
 *
 * User report 2026-04-22: calling check_app_in_browser with url=http://localhost:4001/auth/signup
 * returned "Navigation failed - site unavailable" even though the dev server
 * was serving HTTP 200 at that exact path. Re-run against the root URL with
 * internal navigation to /auth/signup worked fine.
 *
 * Our MCP-side URL handling is known-good: utils/urlParser.ts:132 preserves
 * pathname + search + hash when generating the tunnel URL. If this flow fails,
 * the bug is downstream (ngrok agent strips the path on first hit, OR the
 * backend browser agent's initial navigation doesn't include the path).
 *
 * Failure mode here = P2 bug e01 in effect. Passing = issue was transient or
 * has since been fixed downstream.
 */

import { createServer } from 'http';

const HEADING_AT_ROOT = 'Root Page';
const HEADING_AT_DEEP = 'Deep Path Eval Page';
const DEEP_PATH = '/nested/resource/page';

function makeServer() {
  return createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url === DEEP_PATH) {
      res.end(
        `<!DOCTYPE html><html><head><title>${HEADING_AT_DEEP}</title></head>` +
        `<body><h1 id="heading">${HEADING_AT_DEEP}</h1>` +
        `<p>path=${req.url}</p></body></html>`,
      );
    } else {
      res.end(
        `<!DOCTYPE html><html><head><title>${HEADING_AT_ROOT}</title></head>` +
        `<body><h1 id="heading">${HEADING_AT_ROOT}</h1>` +
        `<p>If the tunnel hit here, the agent did NOT navigate to ${DEEP_PATH}.</p></body></html>`,
      );
    }
  });
}

export const flow = {
  name: 'localhost-deep-path',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'check_app_in_browser against http://localhost:<port>/nested/... must navigate to deep path on FIRST hit (locks bead e01)',
  async run({ client, step, assert, writeArtifact }) {
    const server = makeServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const rootUrl = `http://localhost:${port}`;
    const deepUrl = `http://localhost:${port}${DEEP_PATH}`;
    console.log(`  \x1b[2mroot: ${rootUrl}  deep: ${deepUrl}\x1b[0m`);

    try {
      await step(`first-hit deep path: ${deepUrl} — agent must see "${HEADING_AT_DEEP}", NOT the root page`, async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url: deepUrl,
            description:
              `This page should display a heading that reads exactly "${HEADING_AT_DEEP}". ` +
              `If instead you see "${HEADING_AT_ROOT}", the tunnel stripped the path and you landed on the site root — report failure.`,
          },
        }, 360_000);
        await writeArtifact('raw-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        assert(body.targetUrl === deepUrl, `targetUrl must echo the deep URL, got ${body.targetUrl}`);
        assert(
          body.success === true,
          `Agent reported failure. The deep-path navigation on first hit did not land on ${DEEP_PATH}. ` +
          `outcome=${JSON.stringify(body.outcome).slice(0, 300)}`,
        );
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
