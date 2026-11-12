/**
 * Top-level navigation guard shared by local probe_page (profile sessions) and the
 * local click-through executor. Blocks DOCUMENT loads of the main frame whose host
 * is off the allowlist, redirect hops included, via CDP Fetch (Playwright's route()
 * never sees server-side redirect hops). Sub-resources (CDNs) pass.
 */
import type { BrowserContext, Page } from 'playwright-core';

export function isLoopbackHost(h: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h.toLowerCase());
}

export function safeHost(u: string): string {
  try { return new URL(u).hostname; } catch { return u; }
}

function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((d) => {
    const a = d.trim().toLowerCase().replace(/^\*?\./, '');
    return a !== '' && (h === a || h.endsWith(`.${a}`));
  });
}

type PausedEvent = {
  requestId: string; frameId: string; request: { url: string };
  responseStatusCode?: number; responseHeaders?: Array<{ name: string; value: string }>;
};

/** Guard every current and future page of the context. `onBlocked` receives the refused host. */
export async function installNavigationGuard(
  context: BrowserContext,
  allowed: string[],
  onBlocked: (host: string) => void,
): Promise<void> {
  const check = (u: string): boolean => {
    try { const h = new URL(u).hostname; return hostAllowed(h, allowed) || isLoopbackHost(h); } catch { return false; }
  };
  const guard = async (pg: Page) => {
    const cdp = await context.newCDPSession(pg);
    const mainFrameId = ((await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } }).frameTree.frame.id;
    await cdp.send('Fetch.enable', { patterns: [
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
    ] });
    cdp.on('Fetch.requestPaused', (ev: PausedEvent) => {
      void (async () => {
        try {
          if (ev.frameId !== mainFrameId) { await cdp.send(ev.responseStatusCode ? 'Fetch.continueResponse' : 'Fetch.continueRequest', { requestId: ev.requestId }); return; }
          if (ev.responseStatusCode === undefined) {
            if (!check(ev.request.url)) { onBlocked(safeHost(ev.request.url)); await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }); return; }
            await cdp.send('Fetch.continueRequest', { requestId: ev.requestId });
            return;
          }
          const loc = ev.responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value;
          if (ev.responseStatusCode >= 300 && ev.responseStatusCode < 400 && loc) {
            const next = new URL(loc, ev.request.url).toString();
            if (!check(next)) { onBlocked(safeHost(next)); await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }); return; }
          }
          await cdp.send('Fetch.continueResponse', { requestId: ev.requestId });
        } catch { /* page closed */ }
      })();
    });
  };
  for (const pg of context.pages()) await guard(pg);
  context.on('page', (pg) => { void guard(pg).catch(() => {}); });
}
