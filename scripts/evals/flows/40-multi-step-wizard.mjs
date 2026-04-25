/**
 * Multi-step interaction: agent fills a 3-step wizard and verifies the
 * success state.
 *
 * Previous content-verification flows (35, 37-39) all test a single page
 * state. This one requires chained UI actions: enter name → Next → enter
 * email → Next → enter message → Submit → observe thank-you page.
 *
 * Fixture: single-page wizard with client-side JS swapping visible step.
 * No backend/form endpoint — submission is simulated by swapping to the
 * success panel. Keeps the fixture hermetic.
 *
 * Agent must:
 *   1. Identify step 1 (visible), fill name field, click Next
 *   2. Identify step 2 (visible after transition), fill email, click Next
 *   3. Identify step 3 (visible after transition), fill message, click Submit
 *   4. Verify the thank-you panel is now visible with the expected heading
 *
 * This is a meaningful step up from passive observation. If the agent's
 * step budget is too tight, or its click/fill semantics are off, or it
 * gives up partway, this flow will catch it.
 *
 * ~60-120s wall time (browser agent + multiple interactions).
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Contact Wizard</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 500px; }
    .step { margin-top: 20px; }
    .step.hidden { display: none; }
    label { display: block; margin-top: 12px; font-weight: 600; }
    input, textarea { width: 100%; padding: 8px; margin-top: 4px; box-sizing: border-box; font-size: 14px; }
    textarea { min-height: 80px; }
    button { margin-top: 16px; padding: 10px 20px; background: #2563eb; color: white; border: 0; cursor: pointer; font-size: 14px; }
    .progress { color: #6b7280; font-size: 14px; margin-bottom: 8px; }
    #thankyou h1 { color: #047857; }
  </style>
</head>
<body>
  <h1>Contact Wizard</h1>

  <div id="step1" class="step">
    <div class="progress">Step 1 of 3</div>
    <h2>Your Name</h2>
    <label for="name">Full Name</label>
    <input type="text" id="name" placeholder="Enter your name" />
    <button id="next1" type="button">Next</button>
  </div>

  <div id="step2" class="step hidden">
    <div class="progress">Step 2 of 3</div>
    <h2>Your Email</h2>
    <label for="email">Email Address</label>
    <input type="email" id="email" placeholder="you@example.com" />
    <button id="next2" type="button">Next</button>
  </div>

  <div id="step3" class="step hidden">
    <div class="progress">Step 3 of 3</div>
    <h2>Your Message</h2>
    <label for="message">Message</label>
    <textarea id="message" placeholder="What's on your mind?"></textarea>
    <button id="submitBtn" type="button">Submit</button>
  </div>

  <div id="thankyou" class="step hidden">
    <h1>Thank you!</h1>
    <p>We received your submission and will be in touch soon.</p>
  </div>

  <script>
    function show(id) {
      ['step1', 'step2', 'step3', 'thankyou'].forEach(function (s) {
        document.getElementById(s).classList.add('hidden');
      });
      document.getElementById(id).classList.remove('hidden');
    }
    document.getElementById('next1').addEventListener('click', function () {
      if (!document.getElementById('name').value.trim()) {
        alert('Please enter your name'); return;
      }
      show('step2');
    });
    document.getElementById('next2').addEventListener('click', function () {
      if (!document.getElementById('email').value.trim()) {
        alert('Please enter your email'); return;
      }
      show('step3');
    });
    document.getElementById('submitBtn').addEventListener('click', function () {
      if (!document.getElementById('message').value.trim()) {
        alert('Please enter a message'); return;
      }
      show('thankyou');
    });
  </script>
</body>
</html>`;

export const flow = {
  name: 'multi-step-wizard',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent fills a 3-step wizard (name → email → message → submit) and verifies the thank-you page appears',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: 3-step wizard at ${url}\x1b[0m`);

    try {
      await step('agent completes all 3 wizard steps and reaches thank-you page', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a 3-step contact wizard. Complete it by:\n' +
              '1. On step 1 ("Your Name"), type "Testbot Tester" in the Full Name field and click Next.\n' +
              '2. On step 2 ("Your Email"), type "testbot@example.com" in the Email Address field and click Next.\n' +
              '3. On step 3 ("Your Message"), type "Automated end-to-end test" in the Message textarea and click Submit.\n' +
              'After submitting, verify the page displays a "Thank you!" heading confirming the submission was received.',
          },
        }, 420_000);

        await writeArtifact('wizard-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('wizard-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed to complete the wizard. outcome='${body.outcome}', success=${body.success}. ` +
          `final intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true,
          `Expected success=true; got ${body.success}`);

        // Multi-step interaction should take more than 1 step of agent work.
        // If stepsTaken is 1, the agent skipped ahead or misidentified the page.
        assert(body.stepsTaken >= 3,
          `Expected agent to take >=3 steps for a 3-step wizard; got stepsTaken=${body.stepsTaken}. ` +
          `This suggests the agent didn't actually navigate through the steps.`);

        // Capture the full action trace for debugging / diagnostic review
        await writeArtifact('action-trace.json', body.actionTrace ?? []);

        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
