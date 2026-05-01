/**
 * Unauthenticated redirect: navigating to a protected page should
 * redirect to login. Agent must land on the login page and recognize
 * it — not report pass because "some page loaded".
 *
 * Fixture: two-route server.
 *   GET /dashboard → HTTP 302 Location: /login
 *   GET /login     → login form with "Sign In" heading
 *   Anything else  → 404
 *
 * Agent is pointed at /dashboard. Browser auto-follows the 302. The
 * agent must recognize the resulting /login page and confirm the
 * redirect behavior via the visible login form, NOT report some
 * hallucinated dashboard state.
 *
 * ~40-60s wall time.
 */

import { createServer } from 'node:http';

const LOGIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Sign In</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 400px; }
    label { display: block; margin-top: 12px; font-weight: 600; }
    input { width: 100%; padding: 8px; margin-top: 4px; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 20px; background: #2563eb; color: white; border: 0; cursor: pointer; }
    .notice { color: #92400e; background: #fef3c7; padding: 10px 14px; border-radius: 4px; margin-bottom: 20px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="notice">You must sign in to access the dashboard.</div>
  <h1>Sign In</h1>
  <form>
    <label for="email">Email</label>
    <input type="email" id="email" placeholder="you@example.com" />
    <label for="password">Password</label>
    <input type="password" id="password" placeholder="••••••••" />
    <button type="submit">Sign In</button>
  </form>
</body>
</html>`;

export const flow = {
  name: 'login-redirect',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Unauthenticated GET /dashboard returns 302 to /login; agent must follow and recognize the login page (not hallucinate dashboard)',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((req, res) => {
      const u = req.url ?? '/';
      if (u === '/dashboard') {
        // Real 302 — browser auto-follows
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
      }
      if (u === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(LOGIN_HTML);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}/dashboard`;
    console.log(`  \x1b[2mfixture: redirect /dashboard → /login at ${url}\x1b[0m`);

    try {
      await step('navigate to /dashboard, follow 302, verify /login page is shown (not dashboard)', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'You are navigating to a protected URL /dashboard. ' +
              'Because you are not signed in, the server will redirect you to the /login page. ' +
              'After the redirect, verify you are on a Sign In page with: ' +
              '(1) a heading "Sign In", ' +
              '(2) a visible notice saying "You must sign in to access the dashboard", ' +
              '(3) Email and Password input fields, ' +
              '(4) a "Sign In" button. ' +
              'The redirect behavior is the expected and CORRECT outcome — the test passes if the login form appears.',
          },
        }, 360_000);

        await writeArtifact('redirect-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('redirect-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed to recognize redirect. outcome='${body.outcome}', success=${body.success}. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        // targetUrl should echo the original URL user sent (the /dashboard
        // path), not the post-redirect /login. Verifies MCP doesn't leak
        // redirected state into the response.
        assert(body.targetUrl === url,
          `targetUrl should echo original /dashboard URL; got '${body.targetUrl}'`);

        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
