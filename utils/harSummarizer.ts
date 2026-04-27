/**
 * harSummarizer — pure HAR + console aggregation utilities.
 *
 * Aggregation key for networkSummary: `origin + pathname` (per system reqs).
 * Refetch loops with varying query strings collapse into a single entry.
 *
 * Pure functions — no I/O, no async — so they can be reused by the future
 * `summarize_execution` tool.
 */

import { NetworkSummaryEntry, ConsoleErrorEntry } from '../types/index.js';

interface BucketState {
  url: string;
  count: number;
  statuses: Record<string, number>;
  totalBytes: number;
  mimeTypes: Set<string>;
}

/**
 * Aggregate HAR `log.entries` into per-endpoint NetworkSummary[], sorted
 * descending by request count (hottest endpoints first). Malformed entries
 * (missing request.url or response.status) are skipped, not thrown.
 */
export function summarizeHar(harEntries: any[]): NetworkSummaryEntry[] {
  if (!Array.isArray(harEntries)) return [];

  const buckets = new Map<string, BucketState>();

  for (const entry of harEntries) {
    try {
      const reqUrl = entry?.request?.url;
      const status = entry?.response?.status;
      if (typeof reqUrl !== 'string' || typeof status !== 'number') continue;

      // Aggregation key: origin + pathname (refetch loops collapse).
      let parsed: URL;
      try {
        parsed = new URL(reqUrl);
      } catch {
        continue;
      }
      const key = `${parsed.origin}${parsed.pathname}`;

      const bytesRaw = entry?.response?.content?.size;
      const bytes = typeof bytesRaw === 'number' && bytesRaw >= 0 ? bytesRaw : 0;
      const mime = entry?.response?.content?.mimeType;
      const mimeStr = typeof mime === 'string' && mime ? mime : '';

      const existing = buckets.get(key);
      if (existing) {
        existing.count++;
        const sk = String(status);
        existing.statuses[sk] = (existing.statuses[sk] ?? 0) + 1;
        existing.totalBytes += bytes;
        if (mimeStr) existing.mimeTypes.add(mimeStr);
      } else {
        buckets.set(key, {
          url: key,
          count: 1,
          statuses: { [String(status)]: 1 },
          totalBytes: bytes,
          mimeTypes: mimeStr ? new Set([mimeStr]) : new Set(),
        });
      }
    } catch {
      // malformed — skip
    }
  }

  return [...buckets.values()]
    .map(({ mimeTypes, url, count, statuses, totalBytes }) => {
      const out: NetworkSummaryEntry = { url, count, statuses, totalBytes };
      // Only attach mimeType when homogeneous — mixed types omit the field.
      if (mimeTypes.size === 1) {
        out.mimeType = [...mimeTypes][0];
      }
      return out;
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * Normalize a console-log JSON array into ConsoleErrorEntry[].
 * Maps backend's snake_case (`line_number`, `url`) to MCP's camelCase
 * (`lineNumber`, `source`). Drops entries that aren't plain objects.
 */
export function summarizeConsole(consoleEntries: any[]): ConsoleErrorEntry[] {
  if (!Array.isArray(consoleEntries)) return [];

  const out: ConsoleErrorEntry[] = [];
  for (const e of consoleEntries) {
    if (typeof e !== 'object' || e === null) continue;

    const entry: ConsoleErrorEntry = {
      level: typeof e.level === 'string' ? e.level : 'log',
      text: typeof e.text === 'string' ? e.text : '',
    };

    // source: prefer `url` (backend convention), fall back to `source`
    const sourceVal = typeof e.url === 'string' && e.url
      ? e.url
      : (typeof e.source === 'string' && e.source ? e.source : undefined);
    if (sourceVal) entry.source = sourceVal;

    // lineNumber: snake_case from backend → camelCase
    const lineVal = typeof e.line_number === 'number'
      ? e.line_number
      : (typeof e.lineNumber === 'number' ? e.lineNumber : undefined);
    if (typeof lineVal === 'number') entry.lineNumber = lineVal;

    if (typeof e.timestamp === 'number') entry.timestamp = e.timestamp;

    out.push(entry);
  }
  return out;
}
