/**
 * The most important content-verification contract: the browser agent
 * MUST distinguish between true and false claims about the same page.
 *
 * Every existing browser-tagged flow asserts the happy path (outcome=pass).
 * None of them test the fail path. That means a regression where the
 * agent rubber-stamps everything — always reporting pass regardless of
 * what's on screen — would slip through the eval suite entirely.
 *
 * This flow fixes that gap with the cheapest-possible fixture: one
 * static login form, two calls.
 *
 *   (a) Truthful description ("login form with email/password fields")
 *       → expect outcome='pass', success=true
 *   (b) False description ("credit card payment form with card/expiry/CVV")
 *       → expect outcome!='pass' AND success=false
 *
 * Same fixture both calls, so the tunnel is reused and cost is ~2x a single
 * check_app_in_browser (~1-2 min total).
 *
 * Additional guard: the two responses must not be byte-identical. If the
 * agent is caching / rubber-stamping / returning a memoized answer, the
 * outcomes would match. We assert they don't.
 *
 * Tagged 'browser', 'browser-local', 'tunnel' — needs real backend + ngrok.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Sign In</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 400px; }
    label { display: block; margin-top: 12px; font-weight: 600; }
    input { width: 100%; padding: 8px; margin-top: 4px; box-sizing: border-box; }
    button { margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: 0; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Sign In</h1>
  <p>Enter your credentials to access your account.</p>
  <form id="login-form" onsubmit="event.preventDefault(); document.getElementById('result').textContent = 'Signed in!';">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" required placeholder="you@example.com" />

    <label for="password">Password</label>
    <input type="password" id="password" name="password" required placeholder="••••••••" />

    <button type="submit" id="submit-btn">Sign In</button>
  </form>
  <p id="result" style="margin-top: 20px; color: green;"></p>
</body>
</html>`;

export const flow = {
  name: 'form-truth-vs-lie',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent differentiates truthful vs. false description of the same login-form fixture — the FAIL path has no other coverage',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: login form at ${url}\x1b[0m`);

    let truthfulBody;
    let lieBody;

    try {
      await step('truthful description ("sign-in form with Email + Password fields") → outcome=pass, success=true', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page should display a sign-in form with an Email field, a Password field, and a button to submit. ' +
              'The heading should say "Sign In".',
          },
        }, 360_000);

        await writeArtifact('truthful-response.json', r);
        assert(!r.isError, `Tool error on truthful call: ${r.content?.[0]?.text?.slice(0, 400)}`);

        truthfulBody = JSON.parse(r.content[0].text);
        await writeArtifact('truthful-body.json', truthfulBody);

        assert(truthfulBody.outcome === 'pass',
          `Expected outcome='pass' for truthful description; got outcome='${truthfulBody.outcome}'. ` +
          `evaluation.reason: ${truthfulBody.evaluation?.reason?.slice(0, 300) ?? '(none)'}`);
        assert(truthfulBody.success === true,
          `Expected success=true for truthful description; got success=${truthfulBody.success}`);
        assert(truthfulBody.targetUrl === url,
          `targetUrl should echo ${url}; got ${truthfulBody.targetUrl}`);
      });

      await step('FALSE description ("credit card payment form with card number + expiry + CVV") → outcome!=pass, success=false', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page should display a credit card payment form with three fields: Card Number, Expiry Date, and CVV. ' +
              'The heading should say "Payment".',
          },
        }, 360_000);

        await writeArtifact('lie-response.json', r);
        assert(!r.isError, `Tool error on false-description call: ${r.content?.[0]?.text?.slice(0, 400)}`);

        lieBody = JSON.parse(r.content[0].text);
        await writeArtifact('lie-body.json', lieBody);

        // The killer assertion: agent must NOT say pass on a false description.
        // If this fails, the eval suite's happy-path-only coverage was hiding
        // a rubber-stamping agent.
        assert(lieBody.outcome !== 'pass',
          `AGENT RUBBER-STAMPED A FALSE DESCRIPTION. ` +
          `Fixture is a sign-in form; description claimed credit card payment form. ` +
          `Got outcome='${lieBody.outcome}', success=${lieBody.success}. ` +
          `evaluation.reason: ${lieBody.evaluation?.reason?.slice(0, 300) ?? '(none)'}`);
        assert(lieBody.success === false,
          `Expected success=false for false description; got success=${lieBody.success}. ` +
          `outcome='${lieBody.outcome}'.`);
      });

      await step('truthful and false responses are not byte-identical — proves two independent evaluations, not a cached answer', async () => {
        // Compare the fields that SHOULD differ if two real evaluations ran:
        // outcome, success, evaluation.reason, maybe stepsTaken.
        // executionId should always differ (new execution); lock that too.
        assert(
          truthfulBody.executionId !== lieBody.executionId,
          `SUSPICIOUS: both calls returned the same executionId=${truthfulBody.executionId}. ` +
          `Looks like the second call reused the first call's execution instead of running its own.`,
        );
        assert(
          truthfulBody.outcome !== lieBody.outcome,
          `SUSPICIOUS: both calls returned identical outcome='${truthfulBody.outcome}'. ` +
          `Given the descriptions were contradictory, at least one of them should disagree with the fixture.`,
        );
        await writeArtifact('comparison.json', {
          truthful: {
            outcome: truthfulBody.outcome,
            success: truthfulBody.success,
            executionId: truthfulBody.executionId,
            stepsTaken: truthfulBody.stepsTaken,
            reason: truthfulBody.evaluation?.reason,
          },
          lie: {
            outcome: lieBody.outcome,
            success: lieBody.success,
            executionId: lieBody.executionId,
            stepsTaken: lieBody.stepsTaken,
            reason: lieBody.evaluation?.reason,
          },
        });
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
