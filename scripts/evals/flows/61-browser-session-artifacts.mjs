/**
 * Browser session artifacts: HAR + console-log + recording presigned URLs.
 *
 * Backend release 2026-04-25 added `browser_session.har_url` and
 * `browser_session.console_log_url` to workflow execution detail responses,
 * alongside the pre-existing `recording_url`. The MCP passes the entire
 * `browserSession` block through verbatim on three surfaces:
 *
 *   1. check_app_in_browser — fresh browser-agent run, fastest end-to-end test
 *   2. search_executions (uuid mode) — detail-mode pass-through of any execution
 *   3. trigger_crawl — same pipeline, same fields (covered by flow 23/24 update)
 *
 * Resolves client-feedback items #1 (network capture, bead 4skk) and
 * #7 (console errors, bead qf18) by surfacing the raw artifacts as URLs.
 *
 * Pre-deploy state: backend ships fields → flow passes. If the field is
 * missing the flow fails — that's the contract.
 *
 * Two-step structure:
 *   Step 1: search_executions uuid mode → asserts browserSession on detail
 *           (fast, no new browser run, just reads existing history)
 *   Step 2: check_app_in_browser against example.com → asserts browserSession
 *           on a freshly-completed run (slow, ~60s, real agent)
 */

const HAR_PROBE_BYTES = 1024;
const CONSOLE_PROBE_BYTES = 1024;

/**
 * Validate the shape of a non-null browserSession field. The contract per
 * backend release notes 2026-04-25:
 *   - harUrl, consoleLogUrl, recordingUrl: REQUIRED keys, value is string|null
 *     (null is normal — capture may have failed or been disabled)
 *   - uuid, status, recordingStatus, vncWsPath: optional, string|null when present
 *
 * Caller must already have verified bs is non-null (browserSession itself can
 * legitimately be null on subworkflow-mode executions).
 */
function assertBrowserSessionShape(bs, assert, source) {
  assert(typeof bs === 'object' && bs !== null, `${source}: browserSession is not an object (got ${typeof bs})`);
  // Locked contract — these three keys MUST be present (not just defined).
  // If they're missing, the backend hasn't deployed the new fields yet.
  for (const key of ['harUrl', 'consoleLogUrl', 'recordingUrl']) {
    assert(
      key in bs,
      `${source}: browserSession.${key} key is missing — backend release 2026-04-25 (har_url + console_log_url + recording_url) may not be deployed. Got keys: [${Object.keys(bs).join(', ')}]`,
    );
    const v = bs[key];
    assert(
      v === null || (typeof v === 'string' && v.length > 0),
      `${source}: browserSession.${key} should be string|null, got ${typeof v} (value: ${JSON.stringify(v)?.slice(0, 80)})`,
    );
  }
  for (const key of ['uuid', 'status', 'recordingStatus', 'vncWsPath']) {
    if (!(key in bs)) continue;
    const v = bs[key];
    assert(
      v === null || typeof v === 'string',
      `${source}: browserSession.${key} should be string|null, got ${typeof v}`,
    );
  }
}

/**
 * Range-fetch the first KB of a presigned URL and return {status, bodyHead}.
 * Range header lets us validate reachability + content shape without
 * downloading multi-MB HAR files.
 */
async function probeUrl(url, byteCount) {
  const r = await fetch(url, {
    headers: { Range: `bytes=0-${byteCount - 1}` },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  return { status: r.status, contentType: r.headers.get('content-type'), bodyHead: text };
}

export const flow = {
  name: 'browser-session-artifacts',
  tags: ['browser', 'browser-public', 'exec', 'artifacts'],
  description: 'check_app_in_browser + search_executions surface browserSession.{harUrl, consoleLogUrl, recordingUrl}; presigned URLs are reachable',
  async run({ client, step, assert, assertHas, writeArtifact }) {
    let detailExec = null;

    await step('search_executions uuid mode: detail response carries non-null browserSession with new keys', async () => {
      // Pull recent completed executions and find one with browserSession
      // populated. Two-tier preference:
      //   1. Best: non-null harUrl (real captured artifact — exercises URL probes)
      //   2. Acceptable: non-null browserSession (proves keys flow through)
      // Subworkflow-mode executions often have null sessions; prefer manual/webhook.
      const list = await client.request('tools/call', {
        name: 'search_executions',
        arguments: { status: 'completed', pageSize: 50 },
      }, 30_000);
      assert(!list.isError, `search_executions list failed: ${list.content?.[0]?.text?.slice(0, 300)}`);
      const listBody = JSON.parse(list.content[0].text);
      const candidates = (listBody.executions ?? []).filter(e => e.uuid);
      assert(candidates.length >= 1, `need at least one completed execution in history, got ${candidates.length}`);

      const ordered = [
        ...candidates.filter(e => e.mode && e.mode !== 'subworkflow'),
        ...candidates.filter(e => e.mode === 'subworkflow'),
      ].slice(0, 15);

      let withHarUrl = null;
      let withBsOnly = null;
      let lastChecked = null;
      for (const cand of ordered) {
        const detail = await client.request('tools/call', {
          name: 'search_executions',
          arguments: { uuid: cand.uuid },
        }, 30_000);
        if (detail.isError) continue;
        const body = JSON.parse(detail.content[0].text);
        const exec = body.executions?.[0];
        lastChecked = exec;
        if (!exec?.browserSession) continue;
        if (typeof exec.browserSession.harUrl === 'string' && exec.browserSession.harUrl.length > 0) {
          withHarUrl = exec;
          await writeArtifact('search-executions-detail.json', detail);
          break;
        }
        if (!withBsOnly) {
          withBsOnly = exec;
          await writeArtifact('search-executions-detail.json', detail);
        }
      }

      const chosen = withHarUrl ?? withBsOnly;
      assert(
        chosen,
        `no recent completed execution had a non-null browserSession (checked ${ordered.length}). ` +
        `Last execution checked uuid=${lastChecked?.uuid} mode=${lastChecked?.mode}. ` +
        `Either no manual/webhook executions ran recently or backend isn't populating browser_session.`,
      );

      assertBrowserSessionShape(chosen.browserSession, assert, 'search_executions detail');
      detailExec = chosen;
      console.log(`  \x1b[2m  → using execution ${chosen.uuid.slice(0,8)} (${chosen.mode}); harUrl=${withHarUrl ? 'populated' : 'null'}\x1b[0m`);
    });

    await step('check_app_in_browser response carries browserSession on a fresh run', async () => {
      const r = await client.request('tools/call', {
        name: 'check_app_in_browser',
        arguments: {
          url: 'https://example.com',
          description: 'Confirm the page loads and shows an "Example Domain" heading',
        },
      }, 360_000);
      await writeArtifact('check-app-response.json', r);

      // Account-level workflow_executions quota is environmental, not a
      // contract violation. Skip cleanly with a loud log; preserve strict
      // failure on every other error class so genuine regressions still fail.
      if (r.isError) {
        const errText = r.content?.[0]?.text ?? '';
        if (errText.includes('Quota exceeded')) {
          console.log('  \x1b[2m  → skipped: workflow_executions quota exceeded (environmental, not a contract failure)\x1b[0m');
          return;
        }
        assert(!r.isError, `check_app_in_browser error: ${errText.slice(0, 400)}`);
      }

      const body = JSON.parse(r.content[0].text);
      assertHas(body, 'browserSession');
      assert(
        body.browserSession,
        'browserSession is null/undefined on a successful fresh run — backend should always populate this for completed executions',
      );
      assertBrowserSessionShape(body.browserSession, assert, 'check_app_in_browser');

      // Prefer the fresh run's browserSession over the historical one for
      // subsequent URL-probe steps (more likely to have non-null URLs given
      // the backend release just shipped).
      if (body.browserSession.harUrl || body.browserSession.consoleLogUrl) {
        detailExec = { browserSession: body.browserSession };
      }
    });

    await step('presigned HAR URL (if populated) is reachable + contains HAR-shaped JSON', async () => {
      const harUrl = detailExec?.browserSession?.harUrl;
      if (!harUrl) {
        console.log('  (skipped: harUrl is null — backend reports capture not available for this session)');
        return;
      }
      const probe = await probeUrl(harUrl, HAR_PROBE_BYTES);
      await writeArtifact('har-probe.json', { status: probe.status, contentType: probe.contentType, bodyHeadBytes: probe.bodyHead.length });
      assert(
        probe.status === 200 || probe.status === 206,
        `HAR HEAD/GET returned ${probe.status} — presigned URL may be expired or invalid`,
      );
      // HAR 1.2 spec — top-level "log" key. We only fetched 1KB so we just look
      // for the substring rather than parse-full-JSON (the file is much larger).
      assert(
        probe.bodyHead.includes('"log"'),
        `HAR body doesn't contain expected '"log"' root key. First 200 bytes: ${probe.bodyHead.slice(0, 200)}`,
      );
    });

    await step('presigned console-log URL (if populated) is reachable + JSON-array shaped', async () => {
      const consoleUrl = detailExec?.browserSession?.consoleLogUrl;
      if (!consoleUrl) {
        console.log('  (skipped: consoleLogUrl is null — capture not available for this session)');
        return;
      }
      const probe = await probeUrl(consoleUrl, CONSOLE_PROBE_BYTES);
      await writeArtifact('console-probe.json', { status: probe.status, contentType: probe.contentType, bodyHeadBytes: probe.bodyHead.length });
      assert(
        probe.status === 200 || probe.status === 206,
        `console-log fetch returned ${probe.status}`,
      );
      // Console log is a JSON array per release notes — should start with [ after whitespace trim
      assert(
        probe.bodyHead.trim().startsWith('['),
        `console-log doesn't start with '[' — got: ${probe.bodyHead.slice(0, 100)}`,
      );
    });
  },
};
