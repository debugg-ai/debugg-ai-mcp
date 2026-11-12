/**
 * Local click-through executor. Live block drives a real Chrome against a fixture
 * server and self-skips when none is installed.
 */
import { describe, test, expect, afterAll, beforeAll } from '@jest/globals';
import http from 'node:http';
import { findChrome } from '../../services/localBrowser.js';
import { LocalExecutor } from '../../services/localExecutor/executor.js';

describe('executor gating', () => {
  test('refused unless DEBUGGAI_LOCAL_BROWSER is set', async () => {
    const prev = process.env.DEBUGGAI_LOCAL_BROWSER;
    delete process.env.DEBUGGAI_LOCAL_BROWSER;
    await expect(LocalExecutor.open({ startUrl: 'http://127.0.0.1:1/' })).rejects.toMatchObject({ code: 'LOCAL_BROWSER_DISABLED' });
    if (prev !== undefined) process.env.DEBUGGAI_LOCAL_BROWSER = prev;
  });
  test('profile run without allowlist is refused', async () => {
    process.env.DEBUGGAI_LOCAL_BROWSER = '1';
    delete process.env.DEBUGGAI_PROFILE_ALLOWED_DOMAINS;
    await expect(LocalExecutor.open({ startUrl: 'http://127.0.0.1:1/', useProfile: true })).rejects.toMatchObject({ code: 'PROFILE_ALLOWLIST_REQUIRED' });
  });
});

const live = findChrome() ? describe : describe.skip;
live('executor (real Chrome)', () => {
  let server: http.Server;
  let base = '';
  let seenPassword = '';
  beforeAll(async () => {
    process.env.DEBUGGAI_LOCAL_BROWSER = '1';
    server = http.createServer((q, s) => {
      if (q.url?.startsWith('/login')) {
        let body = ''; q.on('data', (c) => (body += c)); q.on('end', () => { seenPassword = new URLSearchParams(body).get('pw') ?? ''; s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>Welcome</title><h1>Welcome back</h1>'); });
        return;
      }
      if (q.url === '/missing') { s.writeHead(404); s.end('no'); return; }
      if (q.url === '/jump') { s.writeHead(302, { location: 'http://evil.example.net/x' }); s.end(); return; }
      s.writeHead(200, { 'content-type': 'text/html' });
      s.end(`<title>Home</title><h1>Home</h1>
        <button id=b onclick="document.getElementById('o').textContent='clicked';console.error('boom')">Press me</button><div id=o></div>
        <form method=post action=/login><input name=user placeholder="Email"><input name=pw type=password placeholder="Password" value=hunter2><button type=submit>Sign in</button></form>
        <a href=/jump>jump</a>
        <script>fetch('/missing')</script>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });

  const find = (obs: { elements: Array<{ ref: number; name: string; tag: string }> }, name: string) =>
    obs.elements.find((e) => e.name === name)!.ref;

  test('observe, click, type with secret placeholder, submit, redaction, stale ref', async () => {
    const ex = await LocalExecutor.open({ startUrl: base, secrets: { admin: 's3cret' } });
    try {
      const first = (await ex.execute({ type: 'observe' })).observation;
      expect(first.title).toBe('Home');
      expect(first.screenshotBase64?.length).toBeGreaterThan(100);
      expect(first.delta.failedRequests.some((r) => r.url.endsWith('/missing') && r.status === 404)).toBe(true);
      const pw = first.elements.find((e) => e.tag === 'input[password]')!;
      expect(pw.value).toBeUndefined(); // password values never read

      const click = await ex.execute({ type: 'click', ref: find(first, 'Press me') });
      expect(click.actionResult.ok).toBe(true);
      expect(click.observation.text).toContain('clicked');
      expect(click.observation.delta.console.some((c) => c.text === 'boom')).toBe(true);

      const obs2 = click.observation;
      await ex.execute({ type: 'type', ref: find(obs2, 'Email'), text: 'a@b.c' });
      await ex.execute({ type: 'type', ref: find(obs2, 'Password'), text: '{{cred:admin}}' });
      const sub = await ex.execute({ type: 'click', ref: find(obs2, 'Sign in') });
      expect(sub.observation.title).toBe('Welcome');
      expect(seenPassword).toBe('s3cret');

      const stale = await ex.execute({ type: 'click', ref: 9999 });
      expect(stale.actionResult).toMatchObject({ ok: false, error: { code: 'STALE_REF' } });
      const unknown = await ex.execute({ type: 'type', ref: 0, text: '{{cred:nope}}' });
      expect(unknown.actionResult).toMatchObject({ ok: false, error: { code: 'BAD_ACTION' } });
    } finally { await ex.close(); }
  }, 60000);

  test('allowlist: off-list navigate and redirect hops are blocked', async () => {
    const ex = await LocalExecutor.open({ startUrl: base });
    try {
      const nav = await ex.execute({ type: 'navigate', url: 'http://evil.example.net/' });
      expect(nav.actionResult).toMatchObject({ ok: false, error: { code: 'NAV_BLOCKED' } });
      const redirect = await ex.execute({ type: 'navigate', url: `${base}/jump` });
      expect(redirect.actionResult).toMatchObject({ ok: false, error: { code: 'NAV_BLOCKED' } });
      const ok = await ex.execute({ type: 'navigate', url: base });
      expect(ok.actionResult.ok).toBe(true);
    } finally { await ex.close(); }
  }, 60000);

  test('abort signal closes the browser', async () => {
    const ac = new AbortController();
    const ex = await LocalExecutor.open({ startUrl: base, signal: ac.signal });
    await ex.execute({ type: 'observe' });
    ac.abort();
    await new Promise((r) => setTimeout(r, 800));
    const r = await ex.execute({ type: 'observe' });
    expect(r.actionResult.ok).toBe(false);
  }, 60000);
});
