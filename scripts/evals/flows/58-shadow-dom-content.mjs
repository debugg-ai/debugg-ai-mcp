/**
 * Shadow DOM content visibility: locks the CURRENT agent limit.
 *
 * Empirical finding (filed as bead `gkrc`): the browser agent's
 * text_visible assertions cannot reach content inside a Web Component's
 * shadow root. The agent honestly refused to claim seeing it
 * ("hallucination guard: assertion rejected 3 times, last reason=
 * text_not_found") — no hallucination, but a real visibility gap.
 *
 * This flow locks the boundary in two parts:
 *
 *   (1) Pure shadow DOM content ("Hello from shadow DOM" heading
 *       inside the shadow root) → outcome=fail.
 *       Documents the agent's CURRENT limit. When the agent gains
 *       shadow-piercing in future, this flow will UNEXPECTEDLY pass
 *       — that's a signal to update the contract.
 *
 *   (2) Slotted content ("Public Banner" placed via <slot>) lives in
 *       the LIGHT DOM but is rendered through the shadow root → the
 *       agent CAN see this. Documents the workaround.
 *
 * Combined, this flow captures: "use slots / light-DOM content if you
 * want browser-agent verification of components."
 *
 * ~60-100s wall time (2 calls).
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Shadow DOM Test</title>
  <style>
    body { font-family: sans-serif; padding: 40px; }
  </style>
</head>
<body>
  <h1>Web Component Page</h1>
  <p>The card below uses shadow DOM with a slot for light-DOM content.</p>

  <my-card>
    <h2 slot="banner">Public Banner</h2>
    <p slot="banner">This text lives in the LIGHT DOM and is projected via slot.</p>
  </my-card>

  <script>
    class MyCard extends HTMLElement {
      constructor() {
        super();
        var shadow = this.attachShadow({ mode: 'open' });
        shadow.innerHTML =
          '<style>' +
          '.card { padding: 24px; border: 2px solid #2563eb; border-radius: 8px; background: #eff6ff; max-width: 480px; }' +
          'h2 { color: #1e3a8a; }' +
          '.shadow-only { color: #4b5563; font-style: italic; }' +
          '</style>' +
          '<div class="card">' +
            '<h2>Hello from shadow DOM</h2>' +
            '<div class="shadow-only">This heading is encapsulated in a shadow root and lives in shadow-only DOM.</div>' +
            '<hr/>' +
            '<slot name="banner"></slot>' +
          '</div>';
      }
    }
    customElements.define('my-card', MyCard);
  </script>
</body>
</html>`;

export const flow = {
  name: 'shadow-dom-content',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Locks current agent boundary: pure shadow DOM content unreadable (fail), slotted/light-DOM content readable (pass)',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: shadow DOM page at ${url}\x1b[0m`);

    let shadowOnlyBody;
    let slottedBody;

    try {
      await step('pure shadow-DOM content "Hello from shadow DOM" → outcome=fail (locks current agent limit, bead gkrc)', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page contains a <my-card> custom element. ' +
              'Verify that the page displays the heading text "Hello from shadow DOM" — ' +
              'this text is rendered inside the component\'s shadow root.',
          },
        }, 360_000);
        await writeArtifact('shadow-only-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        shadowOnlyBody = JSON.parse(r.content[0].text);
        await writeArtifact('shadow-only-body.json', shadowOnlyBody);

        // CURRENT-LIMIT LOCK: agent cannot see shadow-DOM-only content.
        // If a future agent gains shadow piercing, this assertion will
        // FAIL (because outcome would be pass). That failure is the
        // signal to update the contract.
        assert(shadowOnlyBody.outcome !== 'pass',
          `UNEXPECTED PASS on shadow-DOM-only content. ` +
          `Bead gkrc documented the agent cannot pierce shadow boundaries; this flow locked that. ` +
          `If the agent has been improved, update flow 58's contract — shadow DOM content now readable. ` +
          `intent: ${shadowOnlyBody.actionTrace?.[shadowOnlyBody.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
      });

      await step('slotted (light-DOM) content "Public Banner" → outcome=pass (the documented workaround)', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page contains a <my-card> custom element. ' +
              'It includes a "Public Banner" heading that is projected via a <slot>. ' +
              'This slotted content is in the light DOM, even though the component itself uses shadow DOM. ' +
              'Verify that the heading text "Public Banner" is visible on the page.',
          },
        }, 360_000);
        await writeArtifact('slotted-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        slottedBody = JSON.parse(r.content[0].text);
        await writeArtifact('slotted-body.json', slottedBody);

        assert(slottedBody.outcome === 'pass',
          `Slotted content (light DOM) should be readable. outcome='${slottedBody.outcome}'. ` +
          `intent: ${slottedBody.actionTrace?.[slottedBody.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
      });

      await step('comparison: same fixture, differing visibility — light DOM yes, shadow DOM no', async () => {
        await writeArtifact('comparison.json', {
          shadowOnly: {
            outcome: shadowOnlyBody.outcome,
            success: shadowOnlyBody.success,
            finalIntent: shadowOnlyBody.actionTrace?.[shadowOnlyBody.actionTrace.length - 1]?.intent,
          },
          slotted: {
            outcome: slottedBody.outcome,
            success: slottedBody.success,
            finalIntent: slottedBody.actionTrace?.[slottedBody.actionTrace.length - 1]?.intent,
          },
        });
        assert(shadowOnlyBody.executionId !== slottedBody.executionId, 'two distinct executions');
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
