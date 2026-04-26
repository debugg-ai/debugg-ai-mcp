/**
 * End-to-end proof for trigger_crawl against a localhost URL — verifies the
 * full tunnel path works for crawls the same way it does for check_app_in_browser.
 *
 * Observation strategy: after the crawl returns, read the file-backed tunnel
 * registry at tmpdir()/debugg-ai-tunnels.json and confirm an entry was created
 * for our local port — same technique as flow 21 (tunnel-reuse-after-idle).
 *
 * No projectUuid is passed — backend's KG import skips with reason='no_environment'.
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REGISTRY_FILE = join(tmpdir(), 'debugg-ai-tunnels.json');
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function readRegistry() {
  if (!existsSync(REGISTRY_FILE)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export const flow = {
  name: 'crawl-trigger-localhost',
  tags: ['browser', 'browser-local', 'tunnel', 'crawl'],
  description: 'trigger_crawl against localhost; asserts tunnel is provisioned and crawl reaches terminal status',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!DOCTYPE html><html><head><title>Crawl Eval Site</title></head>` +
        `<body><h1 id="heading">Crawl Eval Landing</h1>` +
        `<p>A tiny static page for the remote browser to crawl through a tunnel.</p>` +
        `<nav><a href="/about">About</a> <a href="/contact">Contact</a></nav>` +
        `</body></html>`,
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const localUrl = `http://localhost:${port}`;
    console.log(`  \x1b[2mlocal server: ${localUrl} (port ${port})\x1b[0m`);

    try {
      let response;

      await step(`trigger_crawl against ${localUrl} — crawl reaches terminal status`, async () => {
        response = await client.request('tools/call', {
          name: 'trigger_crawl',
          arguments: { url: localUrl },
        }, 660_000);
        await writeArtifact('raw-response.json', response);
        assert(!response.isError, `Tool error: ${response.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(response.content[0].text);
        await writeArtifact('body.json', body);

        assert(typeof body.executionId === 'string' && body.executionId.length > 0,
          `executionId missing: ${JSON.stringify(body.executionId)}`);
        assert(TERMINAL_STATUSES.has(body.status),
          `expected terminal status, got: ${body.status}`);
        assert(body.targetUrl === localUrl,
          `targetUrl should echo the localhost URL. Expected ${localUrl}, got ${body.targetUrl}`);
      });

      await step('crawl actually worked through the tunnel (pagesDiscovered >= 1, actionsExecuted >= 1)', async () => {
        const body = JSON.parse(response.content[0].text);
        assert(body.crawlSummary, `Missing crawlSummary — crawl may have been silently skipped`);
        assert(body.crawlSummary.success === true, `crawlSummary.success is not true: ${body.crawlSummary.success}`);
        assert(body.crawlSummary.pagesDiscovered >= 1,
          `crawlSummary.pagesDiscovered must be >= 1 through tunnel, got ${body.crawlSummary.pagesDiscovered}`);
        assert(body.crawlSummary.actionsExecuted >= 1,
          `crawlSummary.actionsExecuted must be >= 1 through tunnel, got ${body.crawlSummary.actionsExecuted}`);
      });

      await step('knowledgeGraph skipped (no projectUuid passed) — locks the no_environment path', async () => {
        const body = JSON.parse(response.content[0].text);
        assert(body.knowledgeGraph, `Missing knowledgeGraph`);
        assert(body.knowledgeGraph.imported === false, `Expected imported=false; got ${body.knowledgeGraph.imported}`);
        assert(body.knowledgeGraph.reason === 'no_environment',
          `Expected reason='no_environment'; got '${body.knowledgeGraph.reason}'`);
      });

      await step('tunnel was provisioned for the local port (registry has an entry)', async () => {
        const reg = readRegistry();
        await writeArtifact('registry.json', reg);
        const entry = reg[String(port)];
        assert(
          entry && typeof entry.tunnelId === 'string',
          `Expected tunnel registry entry for port ${port}; got ${JSON.stringify(reg)}`,
        );
        assert(entry.ownerPid > 0, 'tunnel ownerPid must be set');
      });

      await step('browserSession with URL + status keys (releases 2026-04-25 + 2026-04-26)', async () => {
        const body = JSON.parse(response.content[0].text);
        assert('browserSession' in body, 'browserSession key missing on trigger_crawl localhost response');
        const bs = body.browserSession;
        assert(bs && typeof bs === 'object', `browserSession should be a non-null object on a successful crawl, got ${typeof bs}`);
        for (const key of ['harUrl', 'consoleLogUrl', 'recordingUrl']) {
          assert(key in bs, `browserSession.${key} key missing — release 2026-04-25 regressed. Got keys: [${Object.keys(bs).join(', ')}]`);
          const v = bs[key];
          assert(v === null || (typeof v === 'string' && v.length > 0), `browserSession.${key} should be string|null, got ${typeof v}`);
        }
        for (const key of ['harStatus', 'consoleLogStatus', 'harRedactionStatus', 'consoleLogRedactionStatus']) {
          assert(key in bs, `browserSession.${key} key missing — release 2026-04-26 (per-artifact status, bead 3yw6) regressed. Got keys: [${Object.keys(bs).join(', ')}]`);
          const v = bs[key];
          assert(v === null || typeof v === 'string', `browserSession.${key} should be string|null, got ${typeof v}`);
        }
      });

      await step('no internal tunnel URL leaks in the crawl response', async () => {
        const raw = response.content[0].text;
        assert(!raw.includes('ngrok.debugg.ai'),
          `Response leaks internal tunnel URL: ${raw.slice(0, 300)}`);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
