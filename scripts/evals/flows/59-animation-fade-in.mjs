/**
 * CSS animation patience: agent must observe an element that fades in
 * over 1.5s.
 *
 * On page load, a banner has `opacity: 0` and CSS `transition: opacity
 * 1.5s`. After 200ms a class swap to `opacity: 1` triggers the fade.
 *
 * The element is in the DOM the whole time (text content always
 * present), but a screenshot-pixel agent or one that judges from the
 * very first paint would see "transparent" and might miss it.
 *
 * Agents that work primarily off DOM/text — like our backend agent —
 * should pass this trivially because the text node is always there.
 * Agents that rely on visual cues only would struggle. Either result
 * tells us something useful about agent semantics.
 *
 * ~30-50s wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Welcome</title>
  <style>
    body { font-family: sans-serif; padding: 60px; max-width: 600px; }
    .banner {
      padding: 30px;
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      color: white;
      border-radius: 12px;
      font-size: 28px;
      font-weight: 700;
      text-align: center;
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 1.5s ease, transform 1.5s ease;
    }
    .banner.visible {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <h1>Animated Welcome</h1>
  <p>The banner below fades in after page load.</p>

  <div class="banner" id="banner">Welcome to our app — get started below!</div>

  <script>
    setTimeout(function () {
      document.getElementById('banner').classList.add('visible');
    }, 200);
  </script>
</body>
</html>`;

export const flow = {
  name: 'animation-fade-in',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Welcome banner fades in over 1.5s; agent must verify the text content is present',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: fade-in banner at ${url}\x1b[0m`);

    try {
      await step('verify "Welcome to our app" banner text appears (after 1.5s fade-in)', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page displays a welcome banner that fades in via CSS animation. ' +
              'Verify that the banner contains the text "Welcome to our app — get started below!" ' +
              'and is visible to the user (the fade-in animation completes shortly after page load).',
          },
        }, 360_000);

        await writeArtifact('fade-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('fade-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed fade-in verification. outcome='${body.outcome}'. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
