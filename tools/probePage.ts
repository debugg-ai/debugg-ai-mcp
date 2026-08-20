/**
 * Probe Page Tool Definition.
 *
 * Lightweight no-LLM batch page probe — navigate + capture state for 1-20
 * URLs in one backend execution. Returns screenshots, page metadata,
 * structured console errors, and per-URL networkSummary (origin+pathname
 * aggregation that surfaces refetch loops as a single entry).
 *
 * NOT an agent: no LLM in the critical path; no interaction (clicks/fills);
 * no scenario verification. For those, use check_app_in_browser.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ProbePageInputSchema, ValidatedTool } from '../types/index.js';
import { probePageHandler } from '../handlers/probePageHandler.js';
import { READ_ONLY } from './annotations.js';

const DESCRIPTION = `Probe one or more URLs and return their rendered state — screenshot, page metadata (title/finalUrl/statusCode/loadTimeMs), structured console errors, and per-URL network summary (refetch loops collapse into one row by origin+pathname).

WHEN TO USE: "did I just break /settings?" / "smoke-test these 5 routes after my refactor" / "what's actually rendering at /dashboard?" — fast (<10s for 1 URL, <25s for 20), no LLM cost, no agent loop.

NOT FOR: scenario verification (sign in → click X → assert Y), interaction (clicks, form fills, scrolls), or anything requiring agent decisions. Use check_app_in_browser for those.

LOCALHOST SUPPORT: any localhost URL is auto-tunneled. Pre-flight TCP probe fails fast (<2s) if the dev server isn't listening.

BATCH MODE: pass up to 20 targets in one call to share browser session + tunnel — dramatically faster than firing parallel single-URL probes (one execution unit, not N). Per-URL waitForSelector / waitForLoadState / timeoutMs override defaults.

READINESS: navigation settles on CONTENT (the page's DOM going quiet), bounded — not on network silence, which never arrives on a live app, and not on 'load', which blocks on third-party embeds. The default is right for SPAs; reach for waitForSelector, not waitForLoadState, when you need to wait for something specific.

A single failed target's error appears in result.error without failing the whole batch — the other results stay valid.`;

const TARGET_PROPERTIES = {
  url: {
    type: 'string',
    description: 'URL to probe. Public URL or localhost URL (auto-tunneled).',
  },
  waitForSelector: {
    type: 'string',
    description: 'Optional CSS selector to wait for after navigation completes. Useful for SPAs that mount content asynchronously.',
  },
  waitForLoadState: {
    type: 'string',
    enum: ['load', 'domcontentloaded', 'networkidle'],
    // sentinal-kvoou. This description used to read "Default 'load'. Use 'networkidle'
    // for SPAs to wait until the bundle finishes rendering" — advice that hangs on
    // exactly the class of app it names. See __tests__/tools/probePageWaitContract.ts
    // for the measurement against https://debugg.ai.
    description: "When to consider the page ready to capture. Default 'domcontentloaded', followed by a bounded content settle (the page's DOM going quiet) — that is what actually makes a client-rendered SPA safe to screenshot, and it needs no override. Only override for a specific reason: 'load' additionally blocks on every sub-resource, including third-party iframes and images we do not control, so a slow embed can time the whole probe out. 'networkidle' is accepted for compatibility but is never issued — a live site's network does not go idle (analytics, polling, websockets, ads) — and behaves as 'domcontentloaded'. To wait on something specific, use waitForSelector.",
  },
  timeoutMs: {
    type: 'number',
    description: 'Per-URL navigation timeout in milliseconds (1000-30000, default 10000).',
  },
};

export function buildProbePageTool(): Tool {
  return {
    name: 'probe_page',
    title: 'Probe Page',
    annotations: READ_ONLY,
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: TARGET_PROPERTIES,
            required: ['url'],
            additionalProperties: false,
          },
          description: '1-20 URLs to probe. Each entry can carry its own per-URL wait config.',
        },
        includeHtml: {
          type: 'boolean',
          description: "If true, each result includes the page's outerHTML. Default false to keep response size sane.",
        },
        captureScreenshots: {
          type: 'boolean',
          description: 'If true (default), one PNG screenshot is returned per target. Set false for very large batches or when only the structured data matters.',
        },
        repoName: {
          type: 'string',
          description: "GitHub repository name (e.g. 'my-org/my-repo'). Auto-detected from the current git repo — only provide this to scope the probe to a different project context.",
        },
      },
      required: ['targets'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedProbePageTool(): ValidatedTool {
  const tool = buildProbePageTool();
  return {
    ...tool,
    inputSchema: ProbePageInputSchema,
    handler: probePageHandler,
  };
}
