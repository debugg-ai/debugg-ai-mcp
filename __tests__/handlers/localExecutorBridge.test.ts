import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { findChrome } from '../../services/localBrowser.js';
import { sealTo } from '../../services/localExecutor/credentialBox.js';
import { FakeCloud } from '../helpers/fakeCloud.js';

const cloud = new FakeCloud();
let bridge: typeof import('../../handlers/localExecutorBridge.js');

beforeAll(async () => {
  await cloud.start();
  process.env.DEBUGGAI_API_URL = cloud.url;
  process.env.DEBUGGAI_API_KEY = 'k';
  process.env.DEBUGGAI_LOCAL_BROWSER = '1';
  bridge = await import('../../handlers/localExecutorBridge.js');
});
afterAll(() => cloud.stop());

const base = (o: object) => ({ description: 'x', url: 'http://localhost:3000', browser: 'local', ...o }) as never;

describe('localizeCredentials', () => {
  test('passwords become placeholders; real values stay in secrets', () => {
    const { input, secrets } = bridge.localizeCredentials(base({
      username: 'a@b.c', password: 'pw1',
      loginCredentials: [{ username: 'x@y.z', password: 'pw2', label: 'invitee' }],
      auth: { username: 'a@b.c', password: 'pw1' },
    }));
    const json = JSON.stringify(input);
    expect(json).not.toContain('pw1'); expect(json).not.toContain('pw2');
    expect(input.password).toBe('{{cred:a@b.c}}');
    expect(input.loginCredentials![0].password).toBe('{{cred:invitee}}');
    expect(secrets).toEqual({ 'a@b.c': 'pw1', invitee: 'pw2' });
  });
});

describe('localAllowedDomains', () => {
  test('start host + extras + extraOrigins; profile run uses only the explicit list', () => {
    delete process.env.DEBUGGAI_PROFILE_ALLOWED_DOMAINS;
    expect(bridge.localAllowedDomains(base({ allowedDomains: ['a.com'], extraOrigins: ['4304', 'http://host.docker.internal:1'] }), 'http://localhost:3000'))
      .toEqual(['localhost', 'a.com', 'localhost', 'host.docker.internal']);
    expect(bridge.localAllowedDomains(base({ useProfile: true }), 'http://localhost:3000')).toEqual([]);
  });
});

const live = findChrome() ? describe : describe.skip;
live('prepareLocalRun (fake backend, real Chrome)', () => {
  test('creates the session, serves commands after begin(), tears down on end()', async () => {
    const app = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>Local App</title>'); });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    let body: Record<string, unknown> = {};
    const client = { tx: { post: async (_p: string, b: Record<string, unknown>) => { body = b; return { sessionId: 'S1', secret: 'sec', limits: { heartbeatS: 0.1, leaseS: 2 } }; } } };
    const ac = new AbortController();
    const run = await bridge.prepareLocalRun({ client: client as never, input: base({ url }), startUrl: url, secrets: { admin: 'x' }, signal: ac.signal });
    expect(run.sessionId).toBe('S1');
    expect(body).toMatchObject({ executor: 'local', allowedDomains: ['127.0.0.1'], headless: true, capture: { screenshots: 'cloud' } });
    run.begin();
    const r = await cloud.result(cloud.push({ op: 'goto', args: { url } }));
    expect(r).toMatchObject({ ok: true, title: 'Local App' });
    expect(cloud.attached).toMatchObject({ credential_labels: ['admin'], profile: 'ephemeral' });
    cloud.cancel = true;
    const end = await run.end();
    expect(end.commandsRun).toBe(1);
    app.close();
  }, 60000);

  test('a 404 from the backend means the executor API is not enabled', async () => {
    const client = { tx: { post: async () => { throw Object.assign(new Error('nf'), { response: { status: 404 } }); } } };
    await expect(bridge.prepareLocalRun({ client: client as never, input: base({ url: 'http://localhost:1' }), startUrl: 'http://localhost:1', secrets: {}, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'LOCAL_EXECUTOR_UNAVAILABLE' });
  }, 60000);

  test('stored credentials arrive sealed to our session key, are typed locally, and never appear in any request', async () => {
    const app = http.createServer((q, s2) => { if (q.method === 'POST') { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { seen = b; s2.writeHead(200); s2.end('ok'); }); return; } s2.writeHead(200, { 'content-type': 'text/html' }); s2.end('<form method=post><input id=pw name=pw type=password><button>go</button></form>'); });
    let seen = '';
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    let body: Record<string, unknown> = {};
    const client = { tx: { post: async (_p: string, b: Record<string, unknown>) => {
      body = b;
      return { sessionId: 'S9', secret: 'sec', limits: { heartbeatS: 0.1, leaseS: 2 }, credentials: [{ label: 'stored-admin', sealed: sealTo(b.executorPublicKey as string, 'Sup3rSecret!', 'S9') }] };
    } } };
    cloud.cancel = false; cloud.results.length = 0; cloud.headers.length = 0;
    const run = await bridge.prepareLocalRun({ client: client as never, input: base({ url, environmentId: '00000000-0000-4000-8000-000000000000' }), startUrl: url, secrets: {}, signal: new AbortController().signal });
    expect(typeof body.executorPublicKey).toBe('string');
    expect(body.environmentId).toBe('00000000-0000-4000-8000-000000000000');
    run.begin();
    await cloud.result(cloud.push({ op: 'goto', args: { url } }));
    await cloud.result(cloud.push({ op: 'fill', target: { selector: '#pw' }, args: { value: '{{cred:stored-admin}}' } }));
    await cloud.result(cloud.push({ op: 'click', target: { selector: 'button' } }));
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toBe('pw=Sup3rSecret%21');
    expect(cloud.attached).toMatchObject({ credential_labels: ['stored-admin'] });
    expect(JSON.stringify([cloud.attached, cloud.results, body])).not.toContain('Sup3rSecret');
    cloud.cancel = true;
    await run.end();
    app.close();
  }, 60000);

  test('server effective captureMode wins; stored credential also answers to its username', async () => {
    const app = http.createServer((_q, s2) => { s2.writeHead(200, { 'content-type': 'text/html' }); s2.end('<input id=pw type=password>'); });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    const client = { tx: { post: async (_p: string, b: Record<string, unknown>) => ({
      sessionId: 'S10', secret: 'sec', captureMode: 'local_only', limits: { heartbeatS: 0.1, leaseS: 2 },
      credentials: [{ label: 'fixture-admin', username: 'admin', sealed: sealTo(b.executorPublicKey as string, 'Sup3rSecret!', 'S10') }],
    }) } };
    cloud.cancel = false; cloud.results.length = 0; cloud.headers.length = 0;
    const run = await bridge.prepareLocalRun({ client: client as never, input: base({ url }), startUrl: url, secrets: {}, signal: new AbortController().signal });
    run.begin();
    await cloud.result(cloud.push({ op: 'goto', args: { url } }));
    const f = await cloud.result(cloud.push({ op: 'fill', target: { selector: '#pw' }, args: { value: '{{cred:admin}}' } }));
    expect(f.ok).toBe(true);
    const shot = await cloud.result(cloud.push({ op: 'screenshot', upload_url: `${cloud.url}/upload/x.png` }));
    expect((shot.observation?.value as { redacted?: boolean }).redacted).toBe(true);
    expect(cloud.uploads.length).toBe(0);
    cloud.cancel = true;
    await run.end();
    app.close();
  }, 60000);

  test('a plan that does not include local runs surfaces PLAN_REQUIRED with upgrade and docs links', async () => {
    const e402 = Object.assign(new Error('x'), { statusCode: 402, responseData: { error: { code: 'plan_not_entitled', message: 'Local browser runs are not included in your plan.', upgrade_url: 'https://app.debugg.ai/upgrade', docs_url: 'https://debugg.ai/docs/local', required_plans: ['pro'] } } });
    const client = { tx: { post: async () => { throw e402; } } };
    await expect(bridge.prepareLocalRun({ client: client as never, input: base({}), startUrl: 'http://localhost:3000', secrets: {}, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'PLAN_REQUIRED', details: { upgradeUrl: 'https://app.debugg.ai/upgrade', docsUrl: 'https://debugg.ai/docs/local', requiredPlans: ['pro'] } });
  });

  test('planRequiredFromError: 402 and plan-coded 403 only', () => {
    const mk = (statusCode: number, responseData: unknown) => Object.assign(new Error('x'), { statusCode, responseData });
    expect(bridge.planRequiredFromError(mk(402, { detail: 'upgrade needed' }))?.message).toContain('upgrade needed');
    expect(bridge.planRequiredFromError(mk(403, { code: 'plan_required' }))?.code).toBe('PLAN_REQUIRED');
    expect(bridge.planRequiredFromError(mk(403, { code: 'forbidden' }))).toBeUndefined();
    expect(bridge.planRequiredFromError(mk(404, {}))).toBeUndefined();
    expect(bridge.planRequiredFromError(new Error('boom'))).toBeUndefined();
  });

  test('the platform contract shape: flat 402 with error_code PLAN_FEATURE_NOT_INCLUDED', () => {
    const e = Object.assign(new Error('x'), { statusCode: 402, responseData: {
      error: 'Local browser runs are not included in your plan.', error_code: 'PLAN_FEATURE_NOT_INCLUDED', detail: 'Local browser runs are not included in your plan.',
      feature: 'local_browser', upgrade_url: 'https://app.debugg.ai/billing', docs_url: 'https://debugg.ai/docs/local', required_plans: ['Professional', 'Grow', 'Enterprise'] } });
    const r = bridge.planRequiredFromError(e)!;
    expect(r.code).toBe('PLAN_REQUIRED');
    expect(r.message).toBe('Local browser runs are not included in your plan. Upgrade: https://app.debugg.ai/billing Docs: https://debugg.ai/docs/local');
    expect(r.details).toEqual({ upgradeUrl: 'https://app.debugg.ai/billing', docsUrl: 'https://debugg.ai/docs/local', requiredPlans: ['Professional', 'Grow', 'Enterprise'] });
  });
});
