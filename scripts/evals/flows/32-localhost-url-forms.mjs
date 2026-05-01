/**
 * URL-form equivalence for localhost variants.
 *
 * Users refer to the same localhost endpoint in multiple forms:
 *   - "localhost:3000"            (bare — no scheme, triggers normalizeUrl)
 *   - "127.0.0.1:3000"            (bare IPv4)
 *   - "http://127.0.0.1:3000"     (explicit IPv4 scheme)
 *   - "http://[::1]:3000"         (IPv6 bracket form)
 *   - "https://localhost:3000"    (https scheme; still localhost)
 *
 * All five must:
 *   1. Pass zod validation (normalizeUrl pipeline handles scheme-less)
 *   2. Extract the same port number (3000 in this test)
 *   3. Hit the pre-flight probe with the same 127.0.0.1 destination
 *      (ngrok forwards to 127.0.0.1 per bead fhg — URL host is cosmetic
 *      beyond "is this localhost")
 *   4. Return LocalServerUnreachable fast against a dead port, with
 *      detail.port reflecting the picked port
 *
 * If any variant is silently rejected, silently treated as non-localhost,
 * or extracts the wrong port, this flow catches it.
 *
 * Tagged 'fast' — no backend, no tunnel, no browser.
 */

import { createServer as createNetServer } from 'node:net';

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (typeof addr !== 'object' || !addr) return reject(new Error('no addr'));
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

async function callAndTime(client, url) {
  const started = Date.now();
  const r = await client.request('tools/call', {
    name: 'check_app_in_browser',
    arguments: { url, description: 'localhost url form equivalence probe' },
  }, 20_000);
  return { r, elapsed: Date.now() - started };
}

export const flow = {
  name: 'localhost-url-forms',
  tags: ['fast', 'protocol', 'bead-1om'],
  description: 'Equivalent localhost URL forms (bare, IP, IPv6, https) all route to same pre-flight probe and fail identically on dead port',
  async run({ client, step, assert, writeArtifact }) {
    const port = await pickFreePort();
    console.log(`  \x1b[2mtesting against free port ${port}\x1b[0m`);

    // [label, url-as-user-would-send]
    // Every variant points at the same port. The probe MUST probe that
    // port on 127.0.0.1 (ngrok's dial path) regardless of which form the
    // user typed.
    const variants = [
      ['bare-localhost',   `localhost:${port}`],
      ['bare-ipv4',        `127.0.0.1:${port}`],
      ['explicit-ipv4',    `http://127.0.0.1:${port}`],
      ['ipv6-brackets',    `http://[::1]:${port}`],
      ['https-localhost',  `https://localhost:${port}`],
    ];

    const results = [];

    for (const [label, url] of variants) {
      await step(`${label} (${url}) returns LocalServerUnreachable in <10s with detail.port=${port}`, async () => {
        const { r, elapsed } = await callAndTime(client, url);
        results.push({ label, url, elapsed, isError: r.isError, body: r.content?.[0]?.text });

        assert(elapsed < 10_000, `${label}: took ${elapsed}ms — pre-flight should be <2s, never fall through to backend`);
        assert(r.isError === true, `${label}: expected isError:true; got ${JSON.stringify(r).slice(0, 300)}`);

        const body = JSON.parse(r.content[0].text);
        assert(
          body.error === 'LocalServerUnreachable',
          `${label}: expected error='LocalServerUnreachable'; got ${body.error} — did the URL form bypass pre-flight? body: ${JSON.stringify(body).slice(0, 300)}`,
        );
        assert(
          body.detail?.port === port,
          `${label}: expected detail.port=${port} (the port the user specified); got ${body.detail?.port}. If this fails for [::1]:P the IPv6 bracket stripping is broken.`,
        );
        assert(
          body.outcome !== 'pass',
          `${label}: HARD FAIL — false-positive pass on ${url}`,
        );
      });
    }

    await step('all variants behave identically — same error class, same port, no variant slipped through', async () => {
      await writeArtifact('all-variants.json', results);
      const errors = new Set(results.map((r) => JSON.parse(r.body).error));
      assert(errors.size === 1 && errors.has('LocalServerUnreachable'),
        `Expected all variants → LocalServerUnreachable; got set: ${[...errors].join(', ')}`);
      const ports = new Set(results.map((r) => JSON.parse(r.body).detail?.port));
      assert(ports.size === 1 && ports.has(port),
        `Expected all variants → port ${port}; got set: ${[...ports].join(', ')}`);
    });
  },
};
