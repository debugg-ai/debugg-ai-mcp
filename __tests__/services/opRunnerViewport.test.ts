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
});
