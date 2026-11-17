/**
 * Check the agent's own account against what the page really showed. The agent reads a text
 * snapshot of the page and writes its report from that; nothing verifies the report. For a local
 * run the MCP owns the browser, so it can: quoted strings in the report are searched in the final
 * page's visible text, and a quote that is not there is flagged (Tandem prod verify 6.2.7:
 * c478b63a quoted lines the page did not show).
 */

const norm = (s: string): string => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/** Quoted strings ("..." or curly quotes) of 3-160 characters, de-duplicated, in order. */
export function extractQuotes(report: string): string[] {
  const out: string[] = [];
  const re = /"([^"\n]{3,160})"|“([^”\n]{3,160})”/g;
  for (let m = re.exec(report); m; m = re.exec(report)) {
    const q = (m[1] ?? m[2]).trim();
    if (q && !out.includes(q)) out.push(q);
  }
  return out;
}

export interface ReportCheck {
  /** How many quoted strings (or long JSON string values) were looked up. 0 means the report had nothing checkable. */
  checked: number;
  /** Quoted strings from the report that appear in the page's final visible text. */
  quotesFound: string[];
  /** Quoted strings that do NOT appear: the agent claimed text the page did not show. */
  quotesNotFound: string[];
}

/** String leaves (values, not keys) of a JSON report that are long enough to be page text, not flags. */
export function jsonStringValues(report: string, minLen = 12): string[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(report); } catch { return undefined; }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { const t = v.trim(); if (t.length >= minLen && !out.includes(t)) out.push(t); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(parsed);
  return out;
}

/**
 * Undefined when there is nothing to check. Prose reports: quoted strings. JSON reports: every string
 * VALUE of 12+ characters (short values are flags like "ok"); a value the agent paraphrased rather than
 * copied shows up as not found, which is the signal: do not trust it as page text.
 */
export function checkReportQuotes(report: string | undefined, pageText: string | undefined): ReportCheck | undefined {
  if (!report || pageText === undefined) return undefined;
  const t = report.trim();
  const quotes = t.startsWith('{') || t.startsWith('[') ? (jsonStringValues(t) ?? []) : extractQuotes(report);
  const hay = norm(pageText);
  const res: ReportCheck = { checked: quotes.length, quotesFound: [], quotesNotFound: [] };
  for (const q of quotes) (hay.includes(norm(q)) ? res.quotesFound : res.quotesNotFound).push(q);
  return res;
}
