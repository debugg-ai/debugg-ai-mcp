/**
 * Local Chrome capture for probe_page (bead jpw3.1 / jpw3.2).
 *
 * Launches the user's installed Chrome through playwright-core on THIS machine
 * and captures a page directly — no tunnel, no cloud browser, nothing uploaded.
 * Everything stays local: screenshots are returned inline and also written under
 * ~/.debugg-ai/captures (0600).
 *
 * Opt-in at the server: DEBUGGAI_LOCAL_BROWSER=1. With `useProfile`, the browser
 * uses an MCP-owned persistent profile (~/.debugg-ai/chrome-profile, override with
 * DEBUGGAI_CHROME_PROFILE_DIR) the user logs into once via `loginToLocalProfile`;
 * the user's everyday Chrome profile is never touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class LocalBrowserError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'LocalBrowserError';
  }
}

export interface LocalCaptureOptions {
  url: string;
  headless?: boolean;
  useProfile?: boolean;
  waitForSelector?: string;
  waitForLoadState?: 'load' | 'domcontentloaded' | 'networkidle';
  timeoutMs?: number;
  includeHtml?: boolean;
  captureScreenshot?: boolean;
  /** Headful + profile only: keep the window open this long (max 10 min) or until the user closes it, so they can sign in once. */
  loginWindowMs?: number;
  /** Hostnames (and their subdomains) the profile session may navigate to. */
  allowedDomains?: string[];
  signal?: AbortSignal;
}

export interface LocalCaptureResult {
  url: string;
  finalUrl: string | null;
  statusCode: number | null;
  title: string | null;
  loadTimeMs: number;
  consoleErrors: Array<{ level: string; text: string }>;
  networkSummary: Array<{ url: string; count: number; statuses: Record<string, number>; totalBytes: number }>;
  /** Hosts a navigation to which was refused by the allowlist (profile sessions). */
  blockedNavigations?: string[];
  html?: string;
  screenshotBase64?: string;
  screenshotPath?: string;
}

/** Host matches an allowed domain exactly or as a subdomain. */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((d) => {
    const a = d.trim().toLowerCase().replace(/^\*?\./, '');
    return a !== '' && (h === a || h.endsWith(`.${a}`));
  });
}

/**
 * Allowlist for a profile session (bead jpw3.3). The server owner's
 * DEBUGGAI_PROFILE_ALLOWED_DOMAINS (comma list) is authoritative when set;
 * otherwise the call must name allowedDomains. Never empty for a profile run.
 */
export function resolveAllowedDomains(perCall: string[] | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const owner = (env.DEBUGGAI_PROFILE_ALLOWED_DOMAINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return owner.length > 0 ? owner : (perCall ?? []).filter(Boolean);
}

export function localBrowserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEBUGGAI_LOCAL_BROWSER === '1' || env.DEBUGGAI_LOCAL_BROWSER === 'true';
}

export function debuggHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEBUGGAI_HOME || path.join(os.homedir(), '.debugg-ai');
}

export function profileDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEBUGGAI_CHROME_PROFILE_DIR || path.join(debuggHome(env), 'chrome-profile');
}

/** Well-known Chrome locations; DEBUGGAI_CHROME_PATH wins. undefined => let playwright try channel 'chrome'. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DEBUGGAI_CHROME_PATH) return env.DEBUGGAI_CHROME_PATH;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [
          `${env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
          `${env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => fs.existsSync(p));
}

async function loadPlaywright(): Promise<typeof import('playwright-core')> {
  try {
    return await import('playwright-core');
  } catch {
    throw new LocalBrowserError(
      'Local browser mode needs the optional dependency playwright-core, which is not installed. Run `npm i playwright-core` next to the MCP.',
      'PLAYWRIGHT_MISSING',
    );
  }
}

function safeHost(u: string): string {
  try { return new URL(u).hostname; } catch { return u; }
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

async function launch(opts: { headless: boolean; useProfile: boolean }) {
  const pw = await loadPlaywright();
  const executablePath = findChrome();
  const base = { headless: opts.headless, ...(executablePath ? { executablePath } : { channel: 'chrome' as const }) };
  try {
    if (opts.useProfile) {
      const dir = profileDir();
      ensurePrivateDir(dir);
      const context = await pw.chromium.launchPersistentContext(dir, { ...base, viewport: { width: 1280, height: 800 } });
      return { context, close: () => context.close() };
    }
    const browser = await pw.chromium.launch(base);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    return { context, close: () => browser.close() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ProcessSingleton|SingletonLock|profile.*in use|already running/i.test(msg)) {
      throw new LocalBrowserError(`The MCP's Chrome profile (${profileDir()}) is already open in another Chrome window. Close it and retry.`, 'PROFILE_LOCKED');
    }
    if (/Executable doesn't exist|Failed to launch|chrome.*not found|distribution/i.test(msg)) {
      throw new LocalBrowserError(`Could not start Chrome (${executablePath ?? "channel 'chrome'"}). Install Google Chrome or set DEBUGGAI_CHROME_PATH. Detail: ${msg.split('\n')[0]}`, 'CHROME_NOT_FOUND');
    }
    throw err;
  }
}

/** Aggregate responses by origin+path (query stripped), capped. */
function summarize(entries: Array<{ url: string; status: number; bytes: number }>) {
  const map = new Map<string, { url: string; count: number; statuses: Record<string, number>; totalBytes: number }>();
  for (const e of entries) {
    let key = e.url;
    try { const u = new URL(e.url); key = u.origin + u.pathname; } catch { /* keep raw */ }
    const row = map.get(key) ?? { url: key, count: 0, statuses: {}, totalBytes: 0 };
    row.count++;
    row.statuses[String(e.status)] = (row.statuses[String(e.status)] ?? 0) + 1;
    row.totalBytes += e.bytes;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 50);
}

export async function localCapture(o: LocalCaptureOptions): Promise<LocalCaptureResult> {
  if (!localBrowserEnabled()) {
    throw new LocalBrowserError('Local browser mode is off. Set DEBUGGAI_LOCAL_BROWSER=1 in the MCP server environment to allow it.', 'LOCAL_BROWSER_DISABLED');
  }
  const allowed = o.useProfile ? resolveAllowedDomains(o.allowedDomains) : [];
  if (o.useProfile && allowed.length === 0) {
    throw new LocalBrowserError('A profile session needs an allowlist of domains it may visit: pass allowedDomains (e.g. ["example.com"]) or have the server owner set DEBUGGAI_PROFILE_ALLOWED_DOMAINS.', 'PROFILE_ALLOWLIST_REQUIRED');
  }
  const timeout = Math.min(Math.max(o.timeoutMs ?? 10000, 1000), 30000);
  const { context, close } = await launch({ headless: o.headless !== false, useProfile: !!o.useProfile });
  const onAbort = () => { void close().catch(() => {}); };
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    if (o.useProfile) {
      const isLocal = (h: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);
      const startHost = (() => { try { return new URL(o.url).hostname; } catch { return ''; } })();
      if (!hostAllowed(startHost, allowed) && !isLocal(startHost)) {
        throw new LocalBrowserError(`${startHost || o.url} is not in the allowlist for this profile session.`, 'DOMAIN_NOT_ALLOWED');
      }
      // Block top-level DOCUMENT loads off the allowlist, redirect hops included, via
      // CDP Fetch (Playwright's route() never sees server-side redirect hops, so it
      // cannot enforce this). Sub-resources (CDNs) pass.
      const guard = async (pg: import('playwright-core').Page) => {
        const cdp = await context.newCDPSession(pg);
        const mainFrameId = ((await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } }).frameTree.frame.id;
        await cdp.send('Fetch.enable', { patterns: [
          { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
          { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
        ] });
        cdp.on('Fetch.requestPaused', (ev: { requestId: string; frameId: string; request: { url: string }; responseStatusCode?: number; responseHeaders?: Array<{ name: string; value: string }> }) => {
          void (async () => {
            const check = (u: string): boolean => {
              try { const h = new URL(u).hostname; return hostAllowed(h, allowed) || isLocal(h); } catch { return false; }
            };
            try {
              if (ev.frameId !== mainFrameId) { await cdp.send(ev.responseStatusCode ? 'Fetch.continueResponse' : 'Fetch.continueRequest', { requestId: ev.requestId }); return; }
              if (ev.responseStatusCode === undefined) {
                if (!check(ev.request.url)) { blocked.push(safeHost(ev.request.url)); await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }); return; }
                await cdp.send('Fetch.continueRequest', { requestId: ev.requestId });
                return;
              }
              const loc = ev.responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value;
              if (ev.responseStatusCode >= 300 && ev.responseStatusCode < 400 && loc) {
                const next = new URL(loc, ev.request.url).toString();
                if (!check(next)) { blocked.push(safeHost(next)); await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }); return; }
              }
              await cdp.send('Fetch.continueResponse', { requestId: ev.requestId });
            } catch { /* page closed */ }
          })();
        });
      };
      await guard(page);
      context.on('page', (pg) => { void guard(pg).catch(() => {}); });
    }
    const blocked: string[] = [];
    const consoleErrors: Array<{ level: string; text: string }> = [];
    const net: Array<{ url: string; status: number; bytes: number }> = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push({ level: m.type(), text: m.text() }); });
    page.on('pageerror', (e) => consoleErrors.push({ level: 'error', text: e.message }));
    page.on('response', (r) => {
      const len = Number(r.headers()['content-length'] ?? 0);
      net.push({ url: r.url(), status: r.status(), bytes: Number.isFinite(len) ? len : 0 });
    });
    const t0 = Date.now();
    let resp: Awaited<ReturnType<typeof page.goto>>;
    try {
      resp = await page.goto(o.url, { waitUntil: o.waitForLoadState === 'load' ? 'load' : 'domcontentloaded', timeout });
    } catch (err) {
      if (blocked.length > 0) {
        throw new LocalBrowserError(`Navigation to ${[...new Set(blocked)].join(', ')} was blocked: not in this profile session's allowlist.`, 'NAVIGATION_BLOCKED');
      }
      throw err;
    }
    if (o.waitForSelector) await page.waitForSelector(o.waitForSelector, { timeout: Math.max(1000, timeout - (Date.now() - t0)) });
    else await page.waitForLoadState('networkidle', { timeout: Math.min(2000, Math.max(500, timeout - (Date.now() - t0))) }).catch(() => {});
    const result: LocalCaptureResult = {
      url: o.url,
      finalUrl: page.url() || null,
      statusCode: resp ? resp.status() : null,
      title: (await page.title().catch(() => '')) || null,
      loadTimeMs: Date.now() - t0,
      consoleErrors,
      networkSummary: summarize(net),
    };
    if (blocked.length > 0) result.blockedNavigations = [...new Set(blocked)];
    if (o.loginWindowMs && o.useProfile && o.headless === false) {
      const ms = Math.min(o.loginWindowMs, 600000);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        context.once('close', () => { clearTimeout(t); resolve(); });
      });
    }
    if (o.includeHtml) result.html = await page.content();
    if (o.captureScreenshot !== false) {
      const buf = await page.screenshot({ type: 'png' });
      result.screenshotBase64 = buf.toString('base64');
      const dir = path.join(debuggHome(), 'captures');
      ensurePrivateDir(dir);
      const file = path.join(dir, `probe-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      result.screenshotPath = file;
    }
    return result;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    await close().catch(() => {});
  }
}
