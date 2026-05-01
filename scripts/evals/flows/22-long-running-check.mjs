/**
 * Long-running single call: multi-page agent walk must complete reliably
 * with continuous progress heartbeats.
 *
 * Locks bead 2f9 — "MCP timeouts when test flow does too much in one call."
 * This flow doesn't make the timeout problem go away (client-side caps are
 * out of scope) — it proves the server holds up its end:
 *   - Completes within the internal 10-min EXECUTION_TIMEOUT_MS
 *   - Emits progress notifications with no gap > 15s (so any cooperative
 *     client that extends the timeout on heartbeat stays alive)
 *   - Agent succeeds
 *
 * The scope guidance in the tool description (one focused check per call)
 * is the LLM-side mitigation — this flow is the server-side regression.
 */

import { createServer } from 'http';

const PAGES = [
  {
    path: '/',
    heading: 'Long Flow Eval: Page 1',
    next: '/step2',
    nextText: 'Continue to step 2',
  },
  {
    path: '/step2',
    heading: 'Long Flow Eval: Page 2',
    next: '/step3',
    nextText: 'Continue to step 3',
  },
  {
    path: '/step3',
    heading: 'Long Flow Eval: Page 3',
    next: '/step4',
    nextText: 'Continue to step 4',
  },
  {
    path: '/step4',
    heading: 'Long Flow Eval: Done',
    next: null,
    nextText: null,
  },
];

const FINAL_HEADING = 'Long Flow Eval: Done';

function renderPage(page) {
  const link = page.next
    ? `<a id="next" href="${page.next}">${page.nextText}</a>`
    : `<p id="done">Flow complete.</p>`;
  return (
    `<!DOCTYPE html><html><head><title>${page.heading}</title></head>` +
    `<body><h1 id="heading">${page.heading}</h1>` +
    `<p>You are on ${page.path}. Follow the link to advance.</p>` +
    link +
    `</body></html>`
  );
}

function makeServer() {
  return createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const page = PAGES.find((p) => p.path === pathname) ?? PAGES[0];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage(page));
  });
}

export const flow = {
  name: 'long-running-check',
  tags: ['browser', 'browser-local', 'tunnel', 'protocol-detail'],
  description: 'Multi-page agent walk completes with continuous progress heartbeats (bead 2f9)',
  async run({ client, step, assert, writeArtifact }) {
    const server = makeServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const localUrl = `http://localhost:${port}`;
    console.log(`  \x1b[2mlocal server: ${localUrl} (4-page chain)\x1b[0m`);

    const progressToken = `long-running-${Date.now()}`;
    const progressEvents = [];
    const off = client.onNotification((method, params) => {
      if (method === 'notifications/progress' && params?.progressToken === progressToken) {
        progressEvents.push({
          progress: params.progress,
          total: params.total,
          message: params.message ?? null,
          t: Date.now(),
        });
      }
    });

    try {
      let response;
      const callStart = Date.now();
      await step('multi-page agent walk — request completes within server cap', async () => {
        response = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url: localUrl,
            description:
              `Starting at the landing page, follow the "Continue" link through each page in sequence ` +
              `until you reach the final page. The final page shows the heading "${FINAL_HEADING}". ` +
              `Report success only after confirming you reached that final heading.`,
          },
          _meta: { progressToken },
        }, 660_000);

        const wallMs = Date.now() - callStart;
        await writeArtifact('raw-response.json', response);
        await writeArtifact('progress-events.json', {
          count: progressEvents.length,
          wallMs,
          events: progressEvents,
        });

        assert(!response.isError, `tool error: ${response.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(response.content[0].text);
        assert(
          body.success === true,
          `agent did not reach final page; outcome=${JSON.stringify(body.outcome).slice(0, 300)}`,
        );
        assert(
          wallMs < 10 * 60 * 1000,
          `call took ${wallMs}ms, exceeded server's 10-min EXECUTION_TIMEOUT_MS (should never happen if status returned)`,
        );
      });

      await step('progress notifications form a continuous heartbeat (no gap > 15s)', async () => {
        assert(progressEvents.length >= 3, `expected >=3 progress events, got ${progressEvents.length}`);
        const last = progressEvents[progressEvents.length - 1];
        assert(last.progress === last.total, `final progress ${last.progress} did not reach total ${last.total}`);

        const MAX_GAP_MS = 15_000;
        let maxGap = 0;
        let gapAtIdx = -1;
        for (let i = 1; i < progressEvents.length; i++) {
          const gap = progressEvents[i].t - progressEvents[i - 1].t;
          if (gap > maxGap) { maxGap = gap; gapAtIdx = i; }
        }
        assert(
          maxGap <= MAX_GAP_MS,
          `progress heartbeat gap too long: ${maxGap}ms at event ${gapAtIdx} ` +
          `(prev="${progressEvents[gapAtIdx - 1]?.message}" → cur="${progressEvents[gapAtIdx]?.message}"). ` +
          `Client-side timeouts rely on these heartbeats to keep the request alive.`,
        );
      });

      await step('progress is monotonic + message non-empty throughout', async () => {
        for (let i = 1; i < progressEvents.length; i++) {
          const prev = progressEvents[i - 1];
          const cur = progressEvents[i];
          assert(cur.progress >= prev.progress, `progress regressed at ${i}: ${prev.progress} → ${cur.progress}`);
          assert(cur.total === prev.total, `total changed between events (${prev.total} → ${cur.total})`);
        }
        for (const e of progressEvents) {
          assert(
            typeof e.message === 'string' && e.message.length > 0,
            `empty progress message at t=${e.t}`,
          );
        }
      });
    } finally {
      off?.();
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
