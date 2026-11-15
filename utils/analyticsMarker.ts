/**
 * Marks MCP-driven browsing as our own automation so the apps' analytics
 * (shared `@startsimpli/analytics/traffic` heuristic) do not count it.
 * The apps honour a non-HttpOnly cookie `analytics_ignore=1` on their own host
 * (the same cookie `?analytics=off` sets). `?analytics=on` in the URL still
 * overrides it for a deliberate real test.
 */
export const ANALYTICS_IGNORE_COOKIE = 'analytics_ignore';
const ONE_YEAR_S = 365 * 24 * 60 * 60;

interface CookieContext {
  addCookies(cookies: Array<{ name: string; value: string; url: string; expires?: number }>): Promise<void>;
}

/** Set the marker cookie for the origin of `url`. Never throws: a cookie we could not set must not fail a run. */
export async function markAnalyticsIgnore(context: CookieContext, url: string): Promise<void> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    await context.addCookies([{
      name: ANALYTICS_IGNORE_COOKIE,
      value: '1',
      url: u.origin + '/',
      expires: Math.floor(Date.now() / 1000) + ONE_YEAR_S,
    }]);
  } catch { /* best effort */ }
}
