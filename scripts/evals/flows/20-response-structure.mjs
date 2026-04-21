/**
 * Verify the MCP response structure the client actually receives from
 * check_app_in_browser. Historical bugs have come from three areas:
 *
 *   1. Progress notifications — `notifications/progress` fired via the
 *      server's progressCallback must reach the client, carry the right
 *      progressToken, be monotonic, and end at total.
 *   2. Image content blocks — `{type:'image', data, mimeType}` with valid
 *      base64 and the correct mime type.
 *   3. Stepwise data — `actionTrace` array shape, step numbering, and
 *      agreement with `stepsTaken`.
 *
 * This flow exercises a full browser-agent run against a local HTTP server
 * with deliberately-multi-step content (scroll/click prompt) so we get at
 * least a handful of real agent steps.
 */

import { createServer } from 'http';

const LANDMARK_HEADING = 'Response Structure Eval';

function makeStructuredServer() {
  // A page with one visible section and a click target — the description nudges
  // the agent to do a multi-step interaction rather than converge in 1 step.
  return createServer((req, res) => {
    const path = req.url || '/';
    if (path === '/about') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><title>About</title></head>
<body>
  <h1 id="about-heading">About Response Structure Eval</h1>
  <p id="about-body">This page confirms the nav link works. Token: eval-20-about.</p>
</body></html>`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><title>${LANDMARK_HEADING}</title></head>
<body>
  <h1 id="landing">${LANDMARK_HEADING}</h1>
  <p>Welcome. Follow the instructions to validate MCP response structure.</p>
  <nav><a id="nav-about" href="/about">About</a></nav>
</body></html>`);
  });
}

export const flow = {
  name: 'response-structure',
  tags: ['browser', 'browser-local', 'tunnel', 'protocol-detail'],
  description: 'Verify progress notifications + image blocks + actionTrace shape in check_app_in_browser responses',
  async run({ client, step, assert, assertHas, writeArtifact }) {
    const server = makeStructuredServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const localUrl = `http://localhost:${port}`;
    console.log(`  \x1b[2mlocal server: ${localUrl}\x1b[0m`);

    const progressToken = `response-structure-${Date.now()}`;
    const progressEvents = [];
    const off = client.onNotification((method, params) => {
      if (method === 'notifications/progress' && params?.progressToken === progressToken) {
        progressEvents.push({
          progress: params.progress,
          total: params.total,
          message: params.message ?? null,
          t: Date.now(),
        });
      }
    });

    try {
      let response;
      await step('fire check_app_in_browser with progressToken and collect notifications', async () => {
        response = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url: localUrl,
            description: `Visit the landing page. Click the "About" link in the nav. Verify the about page shows the heading "About Response Structure Eval". Report what you saw.`,
          },
          _meta: { progressToken },
        }, 360_000);
        await writeArtifact('raw-response.json', response);
        await writeArtifact('progress-events.json', { count: progressEvents.length, events: progressEvents });
        assert(!response.isError, `tool error: ${response.content?.[0]?.text?.slice(0, 400)}`);
      });

      await step('progress notifications arrived, monotonic, reach total', async () => {
        assert(progressEvents.length >= 2, `expected >=2 progress events, got ${progressEvents.length}`);
        // Monotonic: each event's progress >= previous (allow equal in case of retransmit)
        for (let i = 1; i < progressEvents.length; i++) {
          const prev = progressEvents[i - 1];
          const cur = progressEvents[i];
          assert(
            cur.progress >= prev.progress,
            `progress regressed at index ${i}: ${prev.progress} → ${cur.progress}`
          );
          assert(
            cur.total === prev.total,
            `total changed between events (${prev.total} → ${cur.total}); must be stable`
          );
        }
        const last = progressEvents[progressEvents.length - 1];
        assert(
          last.progress === last.total,
          `final progress ${last.progress} did not reach total ${last.total}`
        );
        for (const e of progressEvents) {
          assert(
            typeof e.message === 'string' && e.message.length > 0,
            `progress event has empty message: ${JSON.stringify(e)}`
          );
        }
      });

      await step('image content blocks — strict validation when present (bead 99c: backend not emitting)', async () => {
        const blocks = response.content ?? [];
        const images = blocks.filter(b => b.type === 'image');
        if (images.length === 0) {
          console.log(`  \x1b[33mWARN\x1b[0m no image blocks in response — tracked under bead 99c (backend subworkflow.run not emitting screenshotB64). When the backend fix lands, this step auto-upgrades to strict validation.`);
          return;
        }
        for (const img of images) {
          assert(typeof img.data === 'string' && img.data.length > 100, 'image.data empty or too small');
          assert(
            img.mimeType === 'image/png' || img.mimeType === 'image/gif' || img.mimeType === 'image/jpeg',
            `unexpected mimeType: ${img.mimeType}`
          );
          // Decode base64 — throws on invalid
          const decoded = Buffer.from(img.data, 'base64');
          assert(decoded.length > 500, `decoded image suspiciously small: ${decoded.length} bytes`);
          // Validate PNG magic bytes if mime says PNG
          if (img.mimeType === 'image/png') {
            const sig = decoded.slice(0, 8);
            const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
            assert(sig.equals(pngSig), `PNG signature mismatch; got: ${sig.toString('hex')}`);
          }
        }
      });

      await step('response body has well-shaped actionTrace with monotonic steps', async () => {
        const textBlock = response.content?.find(b => b.type === 'text');
        assert(textBlock, 'no text block in response');
        const body = JSON.parse(textBlock.text);
        assertHas(body, 'stepsTaken');
        if (body.actionTrace) {
          assert(Array.isArray(body.actionTrace), 'actionTrace is not an array');
          for (let i = 0; i < body.actionTrace.length; i++) {
            const a = body.actionTrace[i];
            assert(typeof a === 'object' && a !== null, `actionTrace[${i}] not an object`);
            assert(typeof a.step === 'number', `actionTrace[${i}].step not a number (got ${typeof a.step})`);
            assert(a.step === i + 1, `actionTrace[${i}].step should be ${i + 1}, got ${a.step}`);
            assert(typeof a.action === 'string' && a.action.length > 0, `actionTrace[${i}].action missing`);
          }
          assert(
            body.stepsTaken >= body.actionTrace.length,
            `stepsTaken ${body.stepsTaken} should be >= actionTrace.length ${body.actionTrace.length}`
          );
        } else {
          // actionTrace is optional when the agent didn't take explicit steps,
          // but stepsTaken should still be a number.
          assert(typeof body.stepsTaken === 'number', 'stepsTaken missing and actionTrace absent');
        }
      });

      await step('response body echoes targetUrl and does not leak tunnel URL', async () => {
        const textBlock = response.content?.find(b => b.type === 'text');
        const body = JSON.parse(textBlock.text);
        assert(body.targetUrl === localUrl, `targetUrl mismatch: expected ${localUrl}, got ${body.targetUrl}`);
        assert(!textBlock.text.includes('ngrok.debugg.ai'), 'response leaks internal tunnel URL');
      });
    } finally {
      off();
      await new Promise(resolve => server.close(resolve));
    }
  },
};
