/**
 * Bead 1om regression fence — trigger_crawl variant.
 *
 * Sister flow to 28-localhost-not-listening. The pre-flight port probe and
 * fast structured error path must apply to trigger_crawl exactly the same
 * way as to check_app_in_browser — both handlers call into the same
 * localReachability probes, and a regression in one without the other is
 * still a regression.
 *
 * Picks a guaranteed-free port, sends trigger_crawl, and asserts:
 *   1. response arrives in under 10s (no backend/ngrok blazing)
 *   2. isError is true
 *   3. body.error === 'LocalServerUnreachable'
 *   4. no status:'completed' false positive (the crawl equivalent of
 *      outcome:'pass' — a failed localhost that returns "success" is
 *      the exact false-positive class of bug)
 *
 * Does NOT invoke the real backend crawl — the probe should short-circuit
 * before we get anywhere near it. Tagged 'fast'.
 */

import { createServer } from 'node:net';

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (typeof addr !== 'object' || !addr) return reject(new Error('no addr'));
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

export const flow = {
  name: 'crawl-not-listening',
  tags: ['fast', 'protocol', 'bead-1om', 'crawl'],
  description: 'trigger_crawl against unused localhost port returns LocalServerUnreachable fast (bead 1om regression fence for crawl path)',
  async run({ client, step, assert, writeArtifact }) {
    const port = await pickFreePort();
    const url = `http://localhost:${port}`;

    await step(`trigger_crawl against ${url} (nothing listening) returns LocalServerUnreachable in <10s`, async () => {
      const started = Date.now();
      const r = await client.request('tools/call', {
        name: 'trigger_crawl',
        arguments: { url },
      }, 20_000); // 20s allowance; expect <5s in practice
      const elapsed = Date.now() - started;

      await writeArtifact('not-listening-response.json', r);
      await writeArtifact('timing.json', { port, url, elapsedMs: elapsed });

      // Fast-fail semantics are the whole point
      assert(elapsed < 10_000, `response took ${elapsed}ms — pre-flight probe is supposed to fail in ~1.5s, not wait for backend`);

      assert(r.isError === true, `expected isError:true for unreachable port; got: ${JSON.stringify(r).slice(0, 400)}`);

      const body = JSON.parse(r.content[0].text);
      assert(
        body.error === 'LocalServerUnreachable',
        `expected error='LocalServerUnreachable'; got: ${body.error} — full body: ${JSON.stringify(body).slice(0, 300)}`,
      );
      assert(
        body.detail?.port === port,
        `expected detail.port=${port}; got: ${body.detail?.port}`,
      );
      // The killer assertion — the bug we're fixing is the false "completed"
      assert(
        body.status !== 'completed',
        `HARD FAIL: trigger_crawl returned status='completed' against an unreachable port. This is a false-positive regression analogous to bead 1om.`,
      );
      // Also make sure we didn't somehow get crawlSummary.success:true
      assert(
        body.crawlSummary?.success !== true,
        `HARD FAIL: trigger_crawl returned crawlSummary.success=true against an unreachable port.`,
      );
    });
  },
};
