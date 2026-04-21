/**
 * check_app_in_browser end-to-end against a local HTTP server via the
 * MCP's ngrok tunneling path.
 *
 * This is the MCP server's core value proposition: "point at localhost and
 * it Just Works." Exercises the whole pipeline in-process:
 *   1. Spin up a tiny HTTP server on a random local port
 *   2. Call check_app_in_browser with http://localhost:<port>
 *   3. MCP provisions an ngrok tunnel, sends the public URL to the backend
 *   4. Remote browser hits the tunnel, which forwards to our local server
 *   5. Backend evaluates the page, returns structured result
 *   6. Tunnel is torn down
 *
 * Passes if: no tool error, targetUrl echoes localhost (no tunnel URL leak),
 * success=true, agent reports the expected heading.
 */

import { createServer } from 'http';

const LANDMARK_HEADING = 'MCP Tunnel Eval OK';

export const flow = {
  name: 'localhost-tunnel',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'check_app_in_browser end-to-end through a real ngrok tunnel to local http',
  async run({ client, step, assert, assertHas, writeArtifact }) {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!DOCTYPE html><html><head><title>MCP Tunnel Eval</title></head>` +
        `<body><h1 id="heading">${LANDMARK_HEADING}</h1>` +
        `<p>Served from localhost. If the remote browser can read this heading, tunneling works.</p>` +
        `</body></html>`
      );
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const localUrl = `http://localhost:${port}`;
    console.log(`  \x1b[2mlocal server: ${localUrl}\x1b[0m`);

    try {
      await step(`tunnel to ${localUrl}, assert heading "${LANDMARK_HEADING}" is visible`, async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url: localUrl,
            description: `The page should display a heading that reads exactly "${LANDMARK_HEADING}".`,
          },
        }, 360_000);
        await writeArtifact('tunnel-check.json', r);

        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        const text = r.content[0].text;
        assert(!text.includes('ngrok.debugg.ai'), 'Response leaks internal tunnel URL');

        const body = JSON.parse(text);
        assertHas(body, 'outcome');
        assertHas(body, 'success');
        assertHas(body, 'targetUrl');
        assert(
          body.targetUrl === localUrl,
          `targetUrl should echo the localhost URL, got: ${body.targetUrl}`
        );
        assert(
          body.success === true,
          `Agent reported failure. outcome=${JSON.stringify(body.outcome).slice(0, 300)}`
        );
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
