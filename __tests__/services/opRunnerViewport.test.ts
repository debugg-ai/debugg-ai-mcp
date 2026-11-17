/** Local runner: the requested window size reaches Chrome, and finalScreenshot returns the last page. */
import { describe, test, expect, afterAll } from '@jest/globals';
import http from 'node:http';
import { findChrome } from '../../services/localBrowser.js';
import { OpRunner } from '../../services/localExecutor/opRunner.js';

const live = findChrome() ? describe : describe.skip;
live('OpRunner viewport + finalScreenshot (real Chrome)', () => {
  let app: http.Server;
  afterAll(() => { app?.close(); });

  test('a 390-wide window is what the page sees, and the final screenshot is a PNG of it', async () => {
    app = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>x</title><script>document.title="w"+innerWidth</script>'); });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    const runner = await OpRunner.open({ allowedDomains: ['127.0.0.1'], viewport: { width: 390, height: 844 } });
    try {
      expect(await runner.finalScreenshot()).not.toBeNull();   // an empty page still has a page
      const r = await runner.execute({ id: 'c1', seq: 1, op: 'goto', args: { url } } as never);
      expect(r).toMatchObject({ ok: true, title: 'w390' });
      const png = await runner.finalScreenshot();
      expect(png!.subarray(1, 4).toString()).toBe('PNG');
      expect(png!.readUInt32BE(16)).toBe(390);   // IHDR width
    } finally {
      await runner.close();
    }
  }, 60000);
  test('finalFacts measures horizontal overflow and returns the visible text', async () => {
    const wide = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>Wide</title><body style="margin:0"><div style="width:800px">Hello wide page</div><div style="display:none">hidden words</div>'); });
    await new Promise<void>((r) => wide.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(wide.address() as { port: number }).port}`;
    const runner = await OpRunner.open({ allowedDomains: ['127.0.0.1'], viewport: { width: 390, height: 844 } });
    try {
      await runner.execute({ id: 'c1', seq: 1, op: 'goto', args: { url } } as never);
      const f = await runner.finalFacts();
      expect(f!.title).toBe('Wide');
      expect(f!.viewport.width).toBe(390);
      expect(f!.horizontalOverflowPx).toBeGreaterThanOrEqual(400);   // 800px content in a 390px window
      expect(f!.text).toContain('Hello wide page');
      expect(f!.text).not.toContain('hidden words');                // visible text only
    } finally { await runner.close(); wide.close(); }
  }, 60000);
  test('a click goes to the first VISIBLE match, not a hidden duplicate that comes first', async () => {
    const dup = http.createServer((_q, s) => {
      s.writeHead(200, { 'content-type': 'text/html' });
      s.end('<title>dup</title><a id=hidden href="#a" style="display:none" onclick="document.title=\'hidden-clicked\'">Plan</a><a id=shown href="#b" onclick="document.title=\'shown-clicked\'">Plan</a>');
    });
    await new Promise<void>((r) => dup.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(dup.address() as { port: number }).port}`;
    const runner = await OpRunner.open({ allowedDomains: ['127.0.0.1'] });
    try {
      await runner.execute({ id: 'c1', seq: 1, op: 'goto', args: { url } } as never);
      const r = await runner.execute({ id: 'c2', seq: 2, op: 'click', target: { selector: 'a' }, args: { timeout_ms: 3000 } } as never);
      expect(r).toMatchObject({ ok: true });
      expect((await runner.finalFacts())!.title).toBe('shown-clicked');
    } finally { await runner.close(); dup.close(); }
  }, 60000);

  test('finalFacts text includes accessible names and typed field values, never passwords', async () => {
    const f = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>f</title><button aria-label="Open navigation">=</button><textarea>What projects are active?</textarea><input type=password value="s3cret-pw"><img alt="Team photo" src="data:,">'); });
    await new Promise<void>((r) => f.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(f.address() as { port: number }).port}`;
    const runner = await OpRunner.open({ allowedDomains: ['127.0.0.1'] });
    try {
      await runner.execute({ id: 'c1', seq: 1, op: 'goto', args: { url } } as never);
      const t = (await runner.finalFacts())!.text;
      expect(t).toContain('Open navigation');
      expect(t).toContain('What projects are active?');
      expect(t).toContain('Team photo');
      expect(t).not.toContain('s3cret-pw');
    } finally { await runner.close(); f.close(); }
  }, 60000);
  test('scroll position is reported, and a full-page final screenshot is taller than the viewport one', async () => {
    const tall = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>tall</title><body style="margin:0"><div style="height:3000px">tall page</div>'); });
    await new Promise<void>((r) => tall.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(tall.address() as { port: number }).port}`;
    const runner = await OpRunner.open({ allowedDomains: ['127.0.0.1'], viewport: { width: 390, height: 844 } });
    try {
      await runner.execute({ id: 'c1', seq: 1, op: 'goto', args: { url } } as never);
      await runner.execute({ id: 'c2', seq: 2, op: 'scroll', args: { dy: 900 } } as never);
      await new Promise((r) => setTimeout(r, 200));
      const f = await runner.finalFacts();
      expect(f!.scrollY).toBeGreaterThan(500);          // the run left the page scrolled down
      expect(f!.scrollHeight).toBeGreaterThanOrEqual(3000);
      const view = await runner.finalScreenshot(false);
      const full = await runner.finalScreenshot(true);
      expect(view!.readUInt32BE(20)).toBe(844);          // PNG IHDR height
      expect(full!.readUInt32BE(20)).toBeGreaterThanOrEqual(3000);
    } finally { await runner.close(); tall.close(); }
  }, 60000);
});
