/**
 * Local Chrome capture (beads jpw3.1/.2). The live block drives a real Chrome
 * and self-skips when none is installed.
 */
import { describe, test, expect, afterAll } from '@jest/globals';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localCapture, localBrowserEnabled, findChrome, LocalBrowserError } from '../../services/localBrowser.js';

describe('local browser gating', () => {
  test('off unless DEBUGGAI_LOCAL_BROWSER is set', async () => {
    expect(localBrowserEnabled({})).toBe(false);
    expect(localBrowserEnabled({ DEBUGGAI_LOCAL_BROWSER: '1' } as any)).toBe(true);
    const prev = process.env.DEBUGGAI_LOCAL_BROWSER;
    delete process.env.DEBUGGAI_LOCAL_BROWSER;
    await expect(localCapture({ url: 'http://127.0.0.1:1/' })).rejects.toMatchObject({ code: 'LOCAL_BROWSER_DISABLED' });
    if (prev !== undefined) process.env.DEBUGGAI_LOCAL_BROWSER = prev;
  });
  test('DEBUGGAI_CHROME_PATH wins', () => {
    expect(findChrome({ DEBUGGAI_CHROME_PATH: '/x/chrome' } as any)).toBe('/x/chrome');
  });
});

const live = findChrome() ? describe : describe.skip;
live('local capture (real Chrome)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-local-'));
  let server: http.Server;
  afterAll(() => { server?.close(); fs.rmSync(home, { recursive: true, force: true }); });

  test('captures title, console error, status, screenshot; profile keeps a cookie across runs', async () => {
    process.env.DEBUGGAI_LOCAL_BROWSER = '1';
    process.env.DEBUGGAI_HOME = home;
    server = http.createServer((q, s) => {
      if (q.url === '/set') { s.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=abc; Max-Age=3600; Path=/' }); s.end('<title>Set</title>'); return; }
      if (q.url === '/who') { s.writeHead(200, { 'content-type': 'text/html' }); s.end(`<title>cookie:${q.headers.cookie ?? 'none'}</title>`); return; }
      s.writeHead(200, { 'content-type': 'text/html' });
      s.end('<title>Local Probe</title><h1>hi</h1><script>console.error("boom")</script>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;

    const r = await localCapture({ url: `${base}/` });
    expect(r.title).toBe('Local Probe');
    expect(r.statusCode).toBe(200);
    expect(r.consoleErrors.some((e) => e.text.includes('boom'))).toBe(true);
    expect(r.screenshotBase64!.length).toBeGreaterThan(100);
    expect(fs.statSync(r.screenshotPath!).mode & 0o777).toBe(0o600);
    expect(r.screenshotPath!.startsWith(home)).toBe(true);

    await localCapture({ url: `${base}/set`, useProfile: true, captureScreenshot: false });
    const withProfile = await localCapture({ url: `${base}/who`, useProfile: true, captureScreenshot: false });
    expect(withProfile.title).toBe('cookie:sid=abc');
    const fresh = await localCapture({ url: `${base}/who`, captureScreenshot: false });
    expect(fresh.title).toBe('cookie:none');
  }, 60000);
});
