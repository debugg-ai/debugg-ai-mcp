/**
 * Bead 1om regression fence.
 *
 * User-reported incident 2026-04-24: check_app_in_browser against a localhost
 * URL where nothing was actually listening on the port ran for 5 full minutes
 * and returned outcome:'pass', burning the browser agent's step budget on
 * ERR_NGROK_8012 ngrok errors the caller couldn't see.
 *
 * After the 1om fix, MCP should pre-flight the port locally before any
 * backend/ngrok work and return a structured LocalServerUnreachable error
 * in under a couple seconds.
 *
 * This flow picks a guaranteed-free port, sends check_app_in_browser, and
 * asserts:
 *   1. response arrives fast (well under the 5min server cap)
 *   2. isError is true
 *   3. body.error === 'LocalServerUnreachable'
 *   4. no outcome:'pass' false positive
 *
 * Does NOT run the real browser agent — the whole point is that we short-
 * circuit before hitting the backend. Tagged 'fast' for that reason.
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
  name: 'localhost-not-listening',
  tags: ['fast', 'protocol', 'bead-1om'],
  description: 'check_app_in_browser against unused localhost port returns structured error fast (bead 1om regression fence)',
  async run({ client, step, assert, writeArtifact }) {
    const port = await pickFreePort();
    const url = `http://localhost:${port}`;

    await step(`check_app_in_browser against ${url} (nothing listening) returns LocalServerUnreachable in <5s`, async () => {
      const started = Date.now();
      const r = await client.request('tools/call', {
        name: 'check_app_in_browser',
        arguments: {
          url,
          description: 'any — should never actually run because the port is dead',
        },
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
      // The killer assertion — the bug we're fixing is the false PASS
      assert(
        body.outcome !== 'pass',
        `HARD FAIL: tool returned outcome='pass' against an unreachable port. This is the exact 2026-04-24 false-positive regression.`,
      );
    });
  },
};
