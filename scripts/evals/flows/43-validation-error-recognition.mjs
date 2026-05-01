/**
 * Validation-error recognition: the agent must understand that triggering
 * an error state can be the SUCCESS of a test scenario.
 *
 * Most existing flows test "the happy path renders correctly". This flow
 * tests something subtler: the agent must DELIBERATELY make the page
 * fail validation, then recognize that the resulting error message is
 * exactly what the test asked for.
 *
 * Same fixture, two descriptions:
 *   1. "Fill the form with valid data, verify the success message" →
 *      agent fills + submits + sees "Message sent!" → outcome=pass
 *   2. "Submit the EMPTY form and verify the page shows an
 *      'Email is required' validation error" → agent clicks Submit
 *      WITHOUT filling, sees the error, recognizes the error as the
 *      desired outcome → outcome=pass
 *
 * If the agent equates "error message visible" with "test failed",
 * step 2 would incorrectly fail. That'd be a calibration bug worth
 * catching.
 *
 * ~80-120s wall time (2 browser runs).
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Contact Form</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 500px; }
    label { display: block; margin-top: 12px; font-weight: 600; }
    input, textarea { width: 100%; padding: 8px; margin-top: 4px; box-sizing: border-box; }
    textarea { min-height: 80px; }
    button { margin-top: 16px; padding: 10px 20px; background: #2563eb; color: white; border: 0; cursor: pointer; }
    .error { color: #dc2626; margin-top: 6px; font-size: 14px; display: none; }
    .error.visible { display: block; }
    #success {
      margin-top: 20px; padding: 14px;
      background: #d1fae5; color: #065f46;
      border-left: 4px solid #059669; border-radius: 4px;
      display: none;
    }
    #success.visible { display: block; }
  </style>
</head>
<body>
  <h1>Contact Us</h1>
  <p>Send us a message and we'll get back to you.</p>

  <form id="contact-form">
    <label for="email">Email Address</label>
    <input type="text" id="email" name="email" placeholder="you@example.com" />
    <div class="error" id="email-error">Email is required</div>

    <label for="message">Message</label>
    <textarea id="message" name="message" placeholder="Your message..."></textarea>
    <div class="error" id="message-error">Message is required</div>

    <button type="submit" id="submit-btn">Send Message</button>
  </form>

  <div id="success">Message sent! We'll be in touch soon.</div>

  <script>
    document.getElementById('contact-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = document.getElementById('email').value.trim();
      var message = document.getElementById('message').value.trim();
      var emailError = document.getElementById('email-error');
      var messageError = document.getElementById('message-error');
      var success = document.getElementById('success');

      // Reset state
      emailError.classList.remove('visible');
      messageError.classList.remove('visible');
      success.classList.remove('visible');

      var ok = true;
      if (!email) { emailError.classList.add('visible'); ok = false; }
      if (!message) { messageError.classList.add('visible'); ok = false; }

      if (ok) success.classList.add('visible');
    });
  </script>
</body>
</html>`;

export const flow = {
  name: 'validation-error-recognition',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent recognizes that deliberately triggering a validation error can be the desired test outcome (not always a failure)',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: contact form with validation at ${url}\x1b[0m`);

    let happyBody;
    let validationBody;

    try {
      await step('happy path: fill valid data, submit, verify "Message sent!" success', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a contact form with Email Address and Message fields. ' +
              'Fill in the email field with "user@example.com" and the message field with "Hello, this is a test message". ' +
              'Click the "Send Message" button. ' +
              'Verify that a green success banner appears containing the text "Message sent!".',
          },
        }, 360_000);

        await writeArtifact('happy-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        happyBody = JSON.parse(r.content[0].text);
        await writeArtifact('happy-body.json', happyBody);

        assert(happyBody.outcome === 'pass',
          `Happy-path filled-form submission failed. outcome='${happyBody.outcome}'. ` +
          `intent: ${happyBody.actionTrace?.[happyBody.actionTrace.length - 1]?.intent?.slice(0, 300) ?? '(none)'}`);
        assert(happyBody.success === true, `Expected success=true; got ${happyBody.success}`);
      });

      await step('validation path: submit EMPTY form, verify "Email is required" error appears (the error IS the success)', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a contact form. ' +
              'WITHOUT filling in any fields, click the "Send Message" button to trigger the form\'s validation. ' +
              'Verify that the form displays a red validation error containing the text "Email is required". ' +
              'The presence of this validation error is the expected and CORRECT behavior — the test passes if the error appears.',
          },
        }, 360_000);

        await writeArtifact('validation-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        validationBody = JSON.parse(r.content[0].text);
        await writeArtifact('validation-body.json', validationBody);

        // Critical: the agent must understand "validation error appearing"
        // is the success criterion here. If it confuses "error visible
        // on page" with "test failed", outcome would be 'fail' and this
        // assertion would catch the calibration bug.
        assert(validationBody.outcome === 'pass',
          `AGENT MISCALIBRATED: it treated the validation error as a failure. ` +
          `Description explicitly states the validation error appearing IS the desired outcome. ` +
          `Got outcome='${validationBody.outcome}', success=${validationBody.success}. ` +
          `This is a calibration bug — the agent equated "error visible" with "test failed". ` +
          `intent: ${validationBody.actionTrace?.[validationBody.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(validationBody.success === true,
          `Expected success=true (validation error WAS the success criterion); got ${validationBody.success}`);
      });

      await step('the two runs are distinct (different executionIds)', async () => {
        assert(happyBody.executionId !== validationBody.executionId,
          `executionIds collided — looks cached`);
        await writeArtifact('comparison.json', {
          happy: {
            outcome: happyBody.outcome,
            success: happyBody.success,
            stepsTaken: happyBody.stepsTaken,
            finalIntent: happyBody.actionTrace?.[happyBody.actionTrace.length - 1]?.intent,
          },
          validation: {
            outcome: validationBody.outcome,
            success: validationBody.success,
            stepsTaken: validationBody.stepsTaken,
            finalIntent: validationBody.actionTrace?.[validationBody.actionTrace.length - 1]?.intent,
          },
        });
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
