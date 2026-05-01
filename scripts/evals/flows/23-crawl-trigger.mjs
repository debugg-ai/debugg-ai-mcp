/**
 * End-to-end proof for trigger_crawl against a public URL.
 *
 * Reality-check gate for beads ew8 (handler) + 4n2 (tool def) + xcx (wiring).
 * This is the first flow that exercises the full MCP → backend → Raw Crawl
 * Workflow Template → pollExecution path with a real browser.
 *
 * We intentionally omit projectUuid so the backend's KG import path skips
 * with reason='no_environment' — this flow must never mutate a real project.
 *
 * Asserted shape (matches triggerCrawlHandler.ts response payload):
 *   { executionId, status, targetUrl, durationMs, [outcome?], ... }
 */

const TARGET_URL = 'https://example.com';
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export const flow = {
  name: 'crawl-trigger',
  tags: ['browser', 'browser-public', 'crawl'],
  description: 'trigger_crawl happy path against a public URL; full backend execute+poll',
  async run({ client, step, assert, writeArtifact }) {
    let response;

    await step(`trigger_crawl against ${TARGET_URL} — workflow reaches a terminal status`, async () => {
      response = await client.request('tools/call', {
        name: 'trigger_crawl',
        arguments: { url: TARGET_URL },
      }, 660_000);
      await writeArtifact('raw-response.json', response);

      assert(!response.isError, `Tool error: ${response.content?.[0]?.text?.slice(0, 400)}`);
      assert(Array.isArray(response.content), 'response.content must be an array');
      assert(response.content[0]?.type === 'text', 'first content block must be type=text');
    });

    await step('response body: executionId + terminal status + echoed targetUrl + duration', async () => {
      const text = response.content[0].text;
      const body = JSON.parse(text);
      await writeArtifact('body.json', body);

      assert(typeof body.executionId === 'string' && body.executionId.length > 0,
        `executionId missing or empty: ${JSON.stringify(body.executionId)}`);
      assert(TERMINAL_STATUSES.has(body.status),
        `expected terminal status (completed/failed/cancelled), got: ${body.status}`);
      assert(body.targetUrl === TARGET_URL,
        `targetUrl should echo the input URL. Expected ${TARGET_URL}, got ${body.targetUrl}`);
      assert(typeof body.durationMs === 'number' && body.durationMs > 0,
        `durationMs must be a positive number, got: ${body.durationMs}`);
    });

    await step('crawlSummary proves the crawl actually performed work (not silently skipped)', async () => {
      const body = JSON.parse(response.content[0].text);
      assert(body.crawlSummary, `Missing crawlSummary — the surfer.crawl node did not run or the handler did not extract it. Body: ${response.content[0].text.slice(0, 400)}`);
      assert(body.crawlSummary.success === true, `crawlSummary.success is not true: ${body.crawlSummary.success}`);
      assert(typeof body.crawlSummary.pagesDiscovered === 'number' && body.crawlSummary.pagesDiscovered >= 1,
        `crawlSummary.pagesDiscovered must be >= 1, got ${body.crawlSummary.pagesDiscovered}`);
      assert(typeof body.crawlSummary.actionsExecuted === 'number' && body.crawlSummary.actionsExecuted >= 1,
        `crawlSummary.actionsExecuted must be >= 1, got ${body.crawlSummary.actionsExecuted}`);
      assert(typeof body.crawlSummary.stepsTaken === 'number' && body.crawlSummary.stepsTaken >= 1,
        `crawlSummary.stepsTaken must be >= 1, got ${body.crawlSummary.stepsTaken}`);
    });

    await step('knowledgeGraph skip path: no projectUuid → imported=false, reason=no_environment', async () => {
      const body = JSON.parse(response.content[0].text);
      assert(body.knowledgeGraph, `Missing knowledgeGraph — the knowledge_graph.import node did not run or extraction failed`);
      assert(body.knowledgeGraph.imported === false, `Expected imported=false for no-project call; got ${body.knowledgeGraph.imported}`);
      assert(body.knowledgeGraph.skipped === true, `Expected skipped=true; got ${body.knowledgeGraph.skipped}`);
      assert(body.knowledgeGraph.reason === 'no_environment',
        `Expected reason='no_environment' for no-project call; got '${body.knowledgeGraph.reason}'`);
      assert(body.knowledgeGraph.statesImported === 0, `Skipped import must have statesImported=0; got ${body.knowledgeGraph.statesImported}`);
      assert(body.knowledgeGraph.edgesImported === 0, `Skipped import must have edgesImported=0; got ${body.knowledgeGraph.edgesImported}`);
    });

    await step('browserSession with URL + status keys (releases 2026-04-25 + 2026-04-26)', async () => {
      const body = JSON.parse(response.content[0].text);
      assert('browserSession' in body, 'browserSession key missing on trigger_crawl response');
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

    await step('no internal tunnel URL leaks in the raw response', async () => {
      const raw = response.content[0].text;
      assert(!raw.includes('ngrok.debugg.ai'),
        `Response leaks internal tunnel URL: ${raw.slice(0, 300)}`);
    });

    await step('response does not contain password field (even though none was sent, defensive)', async () => {
      const raw = response.content[0].text;
      assert(!/"password"\s*:/.test(raw),
        `Response contains "password" key — defensive invariant violated: ${raw.slice(0, 300)}`);
    });
  },
};
