/**
 * Local executor end to end: fake cloud (Executor API v1) -> HTTP transport -> session
 * loop -> OpRunner -> real Chrome. Self-skips when Chrome is absent.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChrome } from '../../services/localBrowser.js';
import { OpRunner } from '../../services/localExecutor/opRunner.js';
import { runExecutorSession, type AttachInfo } from '../../services/localExecutor/session.js';
import { HttpExecutorTransport } from '../../services/localExecutor/httpTransport.js';
import { FakeCloud } from '../helpers/fakeCloud.js';

describe('runner gating', () => {
  test('refused unless DEBUGGAI_LOCAL_BROWSER is set; allowlist required', async () => {
    const prev = process.env.DEBUGGAI_LOCAL_BROWSER;
    delete process.env.DEBUGGAI_LOCAL_BROWSER;
    await expect(OpRunner.open({ allowedDomains: ['localhost'] })).rejects.toMatchObject({ code: 'LOCAL_BROWSER_DISABLED' });
    process.env.DEBUGGAI_LOCAL_BROWSER = '1';
    await expect(OpRunner.open({ allowedDomains: [] })).rejects.toMatchObject({ code: 'ALLOWLIST_REQUIRED' });
    if (prev === undefined) delete process.env.DEBUGGAI_LOCAL_BROWSER; else process.env.DEBUGGAI_LOCAL_BROWSER = prev;
  });
});

const ATTACH: AttachInfo = { executor_version: 'test', ops_supported: OpRunner.supportedOps(), browser: { name: 'chrome', headless: true }, profile: 'ephemeral', credential_labels: ['admin'] };
const LIMITS = { heartbeat_s: 0.1, lease_s: 2, max_inline_bytes: 1_000_000, max_batch: 1 };

const live = findChrome() ? describe : describe.skip;
live('executor session (real Chrome, fake cloud)', () => {
  let app: http.Server; let base = '';
  let seenPw = '';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-exec-'));
  beforeAll(async () => {
    process.env.DEBUGGAI_LOCAL_BROWSER = '1';
    process.env.DEBUGGAI_HOME = home;
    app = http.createServer((q, s) => {
      if (q.url === '/login') { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { seenPw = new URLSearchParams(b).get('pw') ?? ''; s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>Welcome</title><h1>Welcome back</h1>'); }); return; }
      if (q.url === '/missing') { s.writeHead(404); s.end('x'); return; }
      if (q.url === '/jump') { s.writeHead(302, { location: 'http://evil.example.net/' }); s.end(); return; }
      s.writeHead(200, { 'content-type': 'text/html' });
      s.end(`<title>Home</title><h1>Home</h1><button id=b onclick="console.error('boom');document.title='clicked'">Press</button>
        <form method=post action=/login><input name=user><input id=pw name=pw type=password><button id=go>Go</button></form>
        <a id=pop href="/" target=_blank>pop</a><script>fetch('/missing')</script>`);
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  });
  afterAll(() => { app?.close(); fs.rmSync(home, { recursive: true, force: true }); });

  async function withSession(fn: (cloud: FakeCloud, end: () => Promise<ReturnType<typeof runExecutorSession> extends Promise<infer R> ? R : never>) => Promise<void>, extra: { screenshots?: 'local_only' } = {}) {
    const cloud = new FakeCloud(); await cloud.start();
    const runner = await OpRunner.open({ allowedDomains: ['127.0.0.1'], secrets: { admin: 's3cret' }, ...extra });
    const transport = new HttpExecutorTransport({ baseUrl: cloud.url, authorization: 'Token tok', sessionId: 'S1', secret: 'sec' });
    const session = runExecutorSession({ transport, runner, attach: ATTACH, limits: LIMITS, retryDelayMs: 50 });
    try { await fn(cloud, async () => { cloud.cancel = true; return session; }); }
    finally { cloud.cancel = true; await session.catch(() => {}); cloud.stop(); }
  }

  test('attach, ops, events, placeholder substitution, redaction', async () => {
    await withSession(async (cloud) => {
      const g = await cloud.result(cloud.push({ op: 'goto', args: { url: base } }));
      expect(g).toMatchObject({ ok: true, title: 'Home' });
      expect(g.events?.some((e) => e.type === 'request_failed' && e.url.endsWith('/missing') && typeof e.ts === 'number')).toBe(true);
      expect(cloud.attached).toMatchObject({ executor_version: 'test', credential_labels: ['admin'] });
      expect(cloud.headers[0]).toMatchObject({ authorization: 'Token tok', 'x-executor-secret': 'sec', 'x-executor-api-version': '1' });

      const c = await cloud.result(cloud.push({ op: 'click', target: { selector: '#b' } }));
      expect(c.title).toBe('clicked');
      expect(c.events?.some((e) => e.type === 'console' && e.text === 'boom')).toBe(true);

      await cloud.result(cloud.push({ op: 'fill', target: { selector: 'input[name=user]' }, args: { value: 'a@b.c' } }));
      const f = await cloud.result(cloud.push({ op: 'fill', target: { selector: '#pw' }, args: { value: '{{cred:admin}}' } }));
      expect(JSON.stringify(f)).not.toContain('s3cret');
      const rb = await cloud.result(cloud.push({ op: 'query', target: { selector: '#pw' }, args: { what: 'value' } }));
      expect(rb.observation?.value).toBe('');
      await cloud.result(cloud.push({ op: 'click', target: { selector: '#go' } }));
      expect(seenPw).toBe('s3cret');
      const t = await cloud.result(cloud.push({ op: 'query', target: { selector: 'h1' }, args: { what: 'text' } }));
      expect(t.observation?.value).toBe('Welcome back');
      const bad = await cloud.result(cloud.push({ op: 'fill', target: { selector: 'input[name=user]' }, args: { value: '{{cred:nope}}' } }));
      expect(bad.error?.code).toBe('invalid_args');
    });
  }, 90000);

  test('errors: not found, unsupported op, domain_blocked (direct and redirect)', async () => {
    await withSession(async (cloud) => {
      await cloud.result(cloud.push({ op: 'goto', args: { url: base } }));
      const nf = await cloud.result(cloud.push({ op: 'click', target: { selector: '#nope' }, args: { timeout_ms: 500 } }));
      expect(nf.error?.code).toBe('target_not_found');
      const un = await cloud.result(cloud.push({ op: 'cookies_get' }));
      expect(un.error).toMatchObject({ code: 'unsupported_op', retryable: false });
      const d1 = await cloud.result(cloud.push({ op: 'goto', args: { url: 'http://evil.example.net/' } }));
      expect(d1.error?.code).toBe('domain_blocked');
      const d2 = await cloud.result(cloud.push({ op: 'goto', args: { url: `${base}/jump` } }));
      expect(d2.error?.code).toBe('domain_blocked');
    });
  }, 90000);

  test('evaluate: function source is invoked with arg; plain expression returns its value', async () => {
    await withSession(async (cloud) => {
      await cloud.result(cloud.push({ op: 'goto', args: { url: base } }));
      const f = await cloud.result(cloud.push({ op: 'evaluate', args: { expression: '(n) => n + 1', arg: 41 } }));
      expect(f.observation?.value).toBe(42);
      const t = await cloud.result(cloud.push({ op: 'evaluate', args: { expression: '() => document.title' } }));
      expect(typeof t.observation?.value).toBe('string');
      const e = await cloud.result(cloud.push({ op: 'evaluate', args: { expression: '1 + 2' } }));
      expect(e.observation?.value).toBe(3);
    });
  }, 90000);

  test('screenshot: upload_url PUT; local_only withholds pixels; popups are paged', async () => {
    await withSession(async (cloud) => {
      await cloud.result(cloud.push({ op: 'goto', args: { url: base } }));
      const s = await cloud.result(cloud.push({ op: 'screenshot', upload_url: `${cloud.url}/upload/a.png?sig=1` }));
      expect(s.observation?.screenshot_ref).toBe(`${cloud.url}/upload/a.png`);
      expect(cloud.uploads[0].subarray(1, 4).toString()).toBe('PNG');
      await cloud.result(cloud.push({ op: 'click', target: { selector: '#pop' } }));
      const pages = await cloud.result(cloud.push({ op: 'list_pages' }));
      expect((pages.observation?.value as unknown[]).length).toBe(2);
    });
    await withSession(async (cloud) => {
      await cloud.result(cloud.push({ op: 'goto', args: { url: base } }));
      const s = await cloud.result(cloud.push({ op: 'screenshot', upload_url: `${cloud.url}/upload/b.png` }));
      expect((s.observation?.value as { redacted: boolean }).redacted).toBe(true);
      expect(cloud.uploads).toHaveLength(0);
    }, { screenshots: 'local_only' });
  }, 90000);

  test('cancel via heartbeat closes the session; replayed idempotency_key is not re-run', async () => {
    const cloud = new FakeCloud(); await cloud.start();
    const runner = await OpRunner.open({ allowedDomains: ['127.0.0.1'] });
    const transport = new HttpExecutorTransport({ baseUrl: cloud.url, authorization: 'Token t', sessionId: 'S', secret: 's' });
    const session = runExecutorSession({ transport, runner, attach: ATTACH, limits: LIMITS, retryDelayMs: 50 });
    await cloud.result(cloud.push({ op: 'goto', args: { url: base } }));
    cloud.push({ op: 'click', target: { selector: '#b' }, idempotency_key: 'k1', id: 'dup1' });
    await cloud.result('dup1');
    cloud.push({ op: 'click', target: { selector: '#b' }, idempotency_key: 'k1', id: 'dup2' });
    await cloud.result('dup2');
    cloud.cancel = true;
    const end = await session;
    expect(end.ended).toBe('cancelled');
    expect(end.commandsRun).toBe(2); // goto + one click; the replay was served from cache
    cloud.stop();
  }, 90000);

  test('lease lost when the cloud disappears', async () => {
    const cloud = new FakeCloud(); await cloud.start();
    const runner = await OpRunner.open({ allowedDomains: ['127.0.0.1'] });
    const transport = new HttpExecutorTransport({ baseUrl: cloud.url, authorization: 'Token t', sessionId: 'S', secret: 's' });
    const session = runExecutorSession({ transport, runner, attach: ATTACH, limits: { ...LIMITS, lease_s: 1 }, retryDelayMs: 50 });
    await cloud.result(cloud.push({ op: 'goto', args: { url: base } }));
    cloud.stop();
    expect((await session).ended).toBe('lease_lost');
  }, 90000);
});

describe('commands envelope', () => {
  test('cancel flag in the poll response ends the session; re-delivered running command is not run twice', async () => {
    let runs = 0; let polls = 0;
    const runner = { execute: async (c: { id: string }) => { runs++; await new Promise((r) => setTimeout(r, 150)); return { command_id: c.id, ok: true, duration_ms: 1 }; }, close: async () => {} };
    const transport = {
      attach: async () => {},
      poll: async () => { polls++; if (polls <= 2) return { commands: [{ id: 'x', seq: 1, op: 'title' }] }; return { commands: [], cancel: true }; },
      postResults: async () => {},
      heartbeat: async () => ({ cancel: false, drain: false }),
    };
    const r = await runExecutorSession({ transport: transport as never, runner: runner as never, attach: {} as never, limits: { heartbeat_s: 5, lease_s: 5, max_inline_bytes: 1, max_batch: 1 } as never });
    expect(r.ended).toBe('cancelled');
    expect(runs).toBe(1);
  });
});

describe('HttpExecutorTransport.upload', () => {
  test('sends executor auth headers and returns the server ref', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return new Response(JSON.stringify({ ref: 'executors/s/c1' }), { status: 201 });
    }) as unknown as typeof fetch;
    const t = new HttpExecutorTransport({ baseUrl: 'http://x', authorization: 'Token abc', sessionId: 's', secret: 'sec', fetchImpl });
    const ref = await t.upload('http://x/api/v1/executors/sessions/s/uploads/c1?sig=1', 'image/png', new Uint8Array([1]));
    expect(ref).toBe('executors/s/c1');
    expect(seen?.headers).toMatchObject({ authorization: 'Token abc', 'x-executor-secret': 'sec', 'content-type': 'image/png' });
  });
  test('falls back to the URL when the server returns no ref; rejects on HTTP error', async () => {
    const ok = (async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
    const bad = (async () => new Response('no', { status: 415 })) as unknown as typeof fetch;
    const mk = (fetchImpl: typeof fetch) => new HttpExecutorTransport({ baseUrl: 'http://x', authorization: 'Token a', sessionId: 's', secret: 'z', fetchImpl });
    expect(await mk(ok).upload('http://x/u?sig=1', 'image/png', new Uint8Array([1]))).toBe('http://x/u');
    await expect(mk(bad).upload('http://x/u', 'image/png', new Uint8Array([1]))).rejects.toThrow('415');
  });
});
