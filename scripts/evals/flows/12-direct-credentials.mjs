/**
 * check_app_in_browser with raw username/password (no credentialId lookup).
 *
 * NOTE: The backend AUTO-CREATES a stored credential from raw username/password
 * and echoes its UUID back as resolvedCredentialId. See bead for that quirk.
 * This flow captures + deletes the auto-created cred to avoid leaking orphan
 * records into the test account.
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

async function deleteCredDirect(projectUuid, envUuid, credUuid) {
  const path = `/api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/${credUuid}/`;
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Token ${API_KEY}` },
  });
  if (!r.ok && r.status !== 404) {
    console.log(`  \x1b[33mWARN\x1b[0m cleanup DELETE ${path}: ${r.status}`);
  }
}

// The default project for this test key — credentials auto-created by the
// backend on raw-password calls land here. Used only for cleanup.
async function findDefaultProject() {
  const r = await fetch(`${API_BASE}/api/v1/projects/?search=debugg-ai-mcp`, {
    headers: { Authorization: `Token ${API_KEY}` },
  });
  const body = await r.json();
  return body.results?.[0];
}

function makeLoginServer({ validUsername, validPassword }) {
  return createServer((req, res) => {
    const cookies = (req.headers.cookie || '').split(';').map(s => s.trim());
    const hasSession = cookies.some(c => c.startsWith('session='));

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><title>MCP Eval Direct-Creds</title></head><body>
<h1>MCP Eval Direct-Creds Login</h1>
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
          res.end(`<h1>Invalid login</h1>`);
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
      res.end(`<h1 id="welcome">Welcome, ${user}!</h1>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
}

export const flow = {
  name: 'direct-credentials',
  description: 'check_app_in_browser with raw username/password in tool args (no credentialId)',
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();
    const validUsername = `direct-user-${ts}`;
    const validPassword = `direct-pw-${ts}-${Math.random().toString(36).slice(2, 8)}`;

    const server = makeLoginServer({ validUsername, validPassword });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://localhost:${server.address().port}`;
    console.log(`  \x1b[2mlocal login server: ${localUrl}\x1b[0m`);

    let autoCreatedCredUuid = null;
    let autoCreatedEnvUuid = null;
    let projectUuid = null;

    try {
      await step('check_app_in_browser with raw username/password — agent logs in', async () => {
        const description = [
          `Sign in to the app using the provided credentials. There is a login form at /.`,
          `After signing in, verify the page shows a heading starting with "Welcome, ".`,
        ].join(' ');

        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url: localUrl,
            description,
            username: validUsername,
            password: validPassword,
          },
        }, 360_000);
        await writeArtifact('direct-login.json', r);

        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 600)}`);
        const text = r.content[0].text;
        assert(!text.includes('ngrok.debugg.ai'), 'Response leaks internal tunnel URL');
        assert(!text.includes(validPassword), 'Response leaked the password in plaintext');

        const body = JSON.parse(text);
        assert(body.success === true, `Agent did not succeed. outcome=${JSON.stringify(body.outcome).slice(0, 300)}`);
        assert(body.targetUrl === localUrl, `targetUrl echo: ${body.targetUrl}`);

        // Backend auto-creates a stored cred from raw username/password — track for cleanup.
        autoCreatedCredUuid = body.resolvedCredentialId ?? null;
        autoCreatedEnvUuid = body.resolvedEnvironmentId ?? null;
      });

      await step('GET auto-created credential — no password field in response', async () => {
        if (!autoCreatedCredUuid || !autoCreatedEnvUuid) {
          console.log('  \x1b[2m(backend did not auto-create a cred — skipping storage check)\x1b[0m');
          return;
        }
        const proj = await findDefaultProject();
        assert(!!proj, 'Could not resolve default project for cred cleanup');
        projectUuid = proj.uuid;

        const url = `${API_BASE}/api/v1/projects/${proj.uuid}/environments/${autoCreatedEnvUuid}/credentials/${autoCreatedCredUuid}/`;
        const r = await fetch(url, { headers: { Authorization: `Token ${API_KEY}` } });
        assert(r.ok, `Failed to GET auto-created cred: ${r.status}`);
        const cred = await r.json();
        assert(!('password' in cred), 'Auto-created cred exposes password field on GET');
        const credText = JSON.stringify(cred);
        assert(!credText.includes(validPassword), 'Auto-created cred leaked the raw password value in its fields');
      });
    } finally {
      if (autoCreatedCredUuid && autoCreatedEnvUuid && projectUuid) {
        await deleteCredDirect(projectUuid, autoCreatedEnvUuid, autoCreatedCredUuid);
        console.log(`  \x1b[2mcleanup: deleted auto-created cred ${autoCreatedCredUuid}\x1b[0m`);
      }
      await new Promise(resolve => server.close(resolve));
    }
  },
};
