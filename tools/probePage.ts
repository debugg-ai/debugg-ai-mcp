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

const DESCRIPTION = `Probe one or more URLs and return their rendered state — screenshot, page metadata (title/finalUrl/statusCode/loadTimeMs), structured console errors, and per-URL network summary (refetch loops collapse into one row by origin+pathname).

WHEN TO USE: "did I just break /settings?" / "smoke-test these 5 routes after my refactor" / "what's actually rendering at /dashboard?" — fast (<10s for 1 URL, <25s for 20), no LLM cost, no agent loop.

NOT FOR: scenario verification (sign in → click X → assert Y), interaction (clicks, form fills, scrolls), or anything requiring agent decisions. Use check_app_in_browser for those.

LOCALHOST SUPPORT: any localhost URL is auto-tunneled. Pre-flight TCP probe fails fast (<2s) if the dev server isn't listening.

BATCH MODE: pass up to 20 targets in one call to share browser session + tunnel — dramatically faster than firing parallel single-URL probes (one execution unit, not N). Per-URL waitForSelector / waitForLoadState / timeoutMs override defaults.

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
    description: "When to consider the page 'loaded' before capturing. Default 'load'. Use 'networkidle' for SPAs to wait until the bundle finishes rendering.",
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
