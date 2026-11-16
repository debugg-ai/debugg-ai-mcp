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
  /** Quoted strings from the report that appear in the page's final visible text. */
  quotesFound: string[];
  /** Quoted strings that do NOT appear: the agent claimed text the page did not show. */
  quotesNotFound: string[];
}

/** Undefined when the report has no quotes (nothing to check) or is a JSON object (quotes are just keys). */
export function checkReportQuotes(report: string | undefined, pageText: string | undefined): ReportCheck | undefined {
  if (!report || pageText === undefined) return undefined;
  const t = report.trim();
  if (t.startsWith('{') || t.startsWith('[')) return undefined;
  const quotes = extractQuotes(report);
  if (quotes.length === 0) return undefined;
  const hay = norm(pageText);
  const res: ReportCheck = { quotesFound: [], quotesNotFound: [] };
  for (const q of quotes) (hay.includes(norm(q)) ? res.quotesFound : res.quotesNotFound).push(q);
  return res;
}
