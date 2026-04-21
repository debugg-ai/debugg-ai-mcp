/**
 * Multi-step browser interaction + end-to-end credential resolution.
 *
 * This closes two gaps at once:
 *   1. 0n5 — multi-step flow: fill form → submit → verify dashboard (stepsTaken >= 3).
 *   2. credentialId round-trip: MCP create_credential → check_app_in_browser credentialId →
 *      backend resolves → agent logs in with real username/password.
 *
 * Local server is a minimal login app: GET / shows form; POST /login validates
 * against a fixed user table; /dashboard renders "Welcome, <user>" if session cookie
 * is set. Passing credentialId (not raw username/password) forces backend resolution.
 *
 * Expected runtime: 3-5 min (real multi-step browser automation).
 */

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(dirname(HERE)));
const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
const API_KEY = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;
const API_BASE = 'https://api.debugg.ai';

async function deleteDirect(path) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Token ${API_KEY}` },
  });
  if (!r.ok && r.status !== 404) {
    console.log(`  \x1b[33mWARN\x1b[0m cleanup DELETE ${path}: ${r.status}`);
  }
}

function makeLoginServer({ validUsername, validPassword }) {
  return createServer((req, res) => {
    const cookies = (req.headers.cookie || '').split(';').map(s => s.trim());
    const hasSession = cookies.some(c => c.startsWith('session='));

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><title>MCP Eval Login</title></head><body>
<h1>MCP Eval Login</h1>
<form method="POST" action="/login">
  <div><label>Username: <input id="username" name="username" type="text" autocomplete="username" /></label></div>
  <div><label>Password: <input id="password" name="password" type="password" autocomplete="current-password" /></label></div>
  <div><button id="submit" type="submit">Sign In</button></div>
</form>
</body></html>`);
      return;
    }

    if (req.method === 'POST' && req.url === '/login') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const u = params.get('username');
        const p = params.get('password');
        if (u === validUsername && p === validPassword) {
          res.writeHead(302, {
            'Set-Cookie': `session=${encodeURIComponent(u)}; Path=/`,
            Location: '/dashboard',
          });
          res.end();
        } else {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html><body><h1 id="error">Invalid login</h1><p>Wrong username or password.</p></body></html>`);
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/dashboard')) {
      if (!hasSession) {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
      const user = decodeURIComponent((cookies.find(c => c.startsWith('session=')) || '').slice('session='.length));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><title>Dashboard</title></head><body>
<h1 id="welcome">Welcome, ${user}!</h1>
<p>Signed-in dashboard — MCP eval target.</p>
</body></html>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
}

export const flow = {
  name: 'multistep-with-credential',
  description: 'Multi-step login flow via credentialId resolution — exercises fill/submit/verify + backend cred injection',
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();
    const validUsername = `mcp-eval-user-${ts}`;
    const validPassword = `mcp-eval-pw-${ts}-${Math.random().toString(36).slice(2, 8)}`;

    const server = makeLoginServer({ validUsername, validPassword });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const localUrl = `http://localhost:${port}`;
    console.log(`  \x1b[2mlocal login server: ${localUrl}\x1b[0m`);

    let projectUuid = null;
    let envUuid = null;
    let credUuid = null;

    try {
      await step('setup: create env + credential via MCP tools', async () => {
        const envResp = await client.request('tools/call', {
          name: 'create_environment',
          arguments: {
            name: `mcp-eval-login-${ts}`,
            url: localUrl,
            description: 'Throwaway login env for multistep credential eval',
          },
        }, 30_000);
        assert(!envResp.isError, `env create failed: ${envResp.content?.[0]?.text?.slice(0, 300)}`);
        const envBody = JSON.parse(envResp.content[0].text);
        projectUuid = envBody.projectUuid;
        envUuid = envBody.environment.uuid;

        const credResp = await client.request('tools/call', {
          name: 'create_credential',
          arguments: {
            environmentId: envUuid,
            label: `mcp-eval-login-${ts}-cred`,
            username: validUsername,
            password: validPassword,
          },
        }, 30_000);
        assert(!credResp.isError, `cred create failed: ${credResp.content?.[0]?.text?.slice(0, 300)}`);
        credUuid = JSON.parse(credResp.content[0].text).credential.uuid;
      });

      await step('check_app_in_browser with credentialId — agent logs in and reaches dashboard', async () => {
        const description = [
          `Sign in to the app. There is a login form at the root URL with username and password fields.`,
          `Use the provided credentials to log in. After signing in, verify that the page shows a heading`,
          `that starts with "Welcome, " (the dashboard page).`,
        ].join(' ');

        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url: localUrl,
            description,
            credentialId: credUuid,
          },
        }, 360_000);
        await writeArtifact('login-run.json', r);

        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 600)}`);
        const text = r.content[0].text;
        assert(!text.includes('ngrok.debugg.ai'), 'Response leaks internal tunnel URL');
        assert(!text.includes(validPassword), 'Response leaked the credential password in plaintext');

        const body = JSON.parse(text);
        assert(body.success === true, `Agent did not succeed. outcome=${JSON.stringify(body.outcome).slice(0, 300)}`);
        assert(body.targetUrl === localUrl, `targetUrl echo: ${body.targetUrl}`);
        assert(
          body.resolvedCredentialId === credUuid,
          `Backend did not echo resolvedCredentialId. Expected ${credUuid}, got ${body.resolvedCredentialId}`
        );
        // q2f: resolvedEnvironmentId should match the env the credential lives under,
        // not the project's default runner env. Backend fix verified here.
        assert(
          body.resolvedEnvironmentId === envUuid,
          `resolvedEnvironmentId should be the credential's own env. Expected ${envUuid}, got ${body.resolvedEnvironmentId}`
        );
        assert(
          (body.stepsTaken ?? 0) >= 2,
          `Expected multi-step interaction (>=2 steps). Got stepsTaken=${body.stepsTaken}. ` +
          `This suggests the agent exited without performing login — likely a backend credential-injection issue.`
        );
      });
    } finally {
      if (credUuid && projectUuid && envUuid) {
        await deleteDirect(`/api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/${credUuid}/`);
        console.log(`  \x1b[2mcleanup: deleted cred ${credUuid}\x1b[0m`);
      }
      if (envUuid && projectUuid) {
        await deleteDirect(`/api/v1/projects/${projectUuid}/environments/${envUuid}/`);
        console.log(`  \x1b[2mcleanup: deleted env ${envUuid}\x1b[0m`);
      }
      await new Promise(resolve => server.close(resolve));
    }
  },
};
