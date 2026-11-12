/**
 * LocalExecutor: runs one brain-chosen Action at a time in a real local Chrome and
 * returns the next Observation. No decisions are made here; policy (allowlist,
 * placeholder substitution) is applied in-line, step/time caps live in the runner.
 */
import { launch, localBrowserEnabled, LocalBrowserError, hostAllowed, resolveAllowedDomains } from '../localBrowser.js';
import { installNavigationGuard, isLoopbackHost } from '../navigationGuard.js';
import { DIGEST_SCRIPT, MAX_ELEMENTS, MAX_TEXT } from './domDigest.js';
import type { Action, ActionErrorCode, ActionResult, ElementInfo, Observation, StepResult } from './types.js';
import type { BrowserContext, Page, Dialog } from 'playwright-core';

export interface LocalExecutorOptions {
  startUrl: string;
  headless?: boolean;
  useProfile?: boolean;
  /** Extra hostnames (with subdomains) the run may navigate to, beyond the start URL's host and loopback. */
  allowedDomains?: string[];
  /** Local secret substitution for `{{cred:label}}` placeholders in `type` text. Never sent to the cloud. */
  secrets?: Record<string, string>;
  signal?: AbortSignal;
  actionTimeoutMs?: number;
}

const SECRET_RE = /\{\{cred:([^}]+)\}\}/g;

export class LocalExecutor {
  private readonly blocked: string[] = [];
  private readonly consoleBuf: Array<{ level: string; text: string }> = [];
  private readonly failedBuf: Array<{ url: string; status: number | 'aborted' }> = [];
  private readonly dialogBuf: Array<{ type: string; message: string }> = [];
  private lastRefCount = 0;
  private closed = false;

  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly closeBrowser: () => Promise<void>,
    private readonly allowed: string[],
    private readonly opts: LocalExecutorOptions,
  ) {}

  static async open(opts: LocalExecutorOptions): Promise<LocalExecutor> {
    if (!localBrowserEnabled()) {
      throw new LocalBrowserError('Local browser mode is off. Set DEBUGGAI_LOCAL_BROWSER=1 in the MCP server environment to allow it.', 'LOCAL_BROWSER_DISABLED');
    }
    let startHost = '';
    try { startHost = new URL(opts.startUrl).hostname; } catch { throw new LocalBrowserError(`Invalid start URL: ${opts.startUrl}`, 'BAD_URL'); }
    const extra = opts.useProfile ? resolveAllowedDomains(opts.allowedDomains) : (opts.allowedDomains ?? []);
    if (opts.useProfile && extra.length === 0) {
      throw new LocalBrowserError('A profile session needs an allowlist of domains it may visit: pass allowedDomains or have the server owner set DEBUGGAI_PROFILE_ALLOWED_DOMAINS.', 'PROFILE_ALLOWLIST_REQUIRED');
    }
    const allowed = [startHost, ...extra].filter(Boolean);
    const { context, close } = await launch({ headless: opts.headless !== false, useProfile: !!opts.useProfile });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      const ex = new LocalExecutor(context, page, close, allowed, opts);
      await installNavigationGuard(context, allowed, (h) => ex.blocked.push(h));
      ex.wire(page);
      context.on('page', (pg) => ex.wire(pg));
      const onAbort = () => { void ex.close(); };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await page.goto(opts.startUrl, { waitUntil: 'domcontentloaded', timeout: opts.actionTimeoutMs ?? 15000 });
        await settle(page);
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        throw new LocalBrowserError(`Could not load ${opts.startUrl}: ${msg}`, ex.blocked.length > 0 ? 'NAVIGATION_BLOCKED' : 'START_URL_UNREACHABLE');
      }
      return ex;
    } catch (err) {
      await close().catch(() => {});
      throw err;
    }
  }

  private wire(pg: Page): void {
    pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') this.consoleBuf.push({ level: m.type(), text: m.text().slice(0, 500) }); });
    pg.on('pageerror', (e) => this.consoleBuf.push({ level: 'error', text: e.message.slice(0, 500) }));
    pg.on('response', (r) => { if (r.status() >= 400) this.failedBuf.push({ url: stripQuery(r.url()), status: r.status() }); });
    pg.on('requestfailed', (r) => this.failedBuf.push({ url: stripQuery(r.url()), status: 'aborted' }));
    pg.on('dialog', (d: Dialog) => {
      this.dialogBuf.push({ type: d.type(), message: d.message().slice(0, 300) });
      void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {});
    });
  }

  /** The page the user would be looking at: newest open page (popups) else the first. */
  private cur(): Page {
    const pages = this.context.pages();
    return pages[pages.length - 1] ?? this.page;
  }

  async execute(action: Action): Promise<StepResult> {
    if (this.closed) return { actionResult: fail('FAILED', 'executor is closed'), observation: emptyObservation() };
    const timeout = this.opts.actionTimeoutMs ?? 15000;
    this.blocked.length = 0;
    let actionResult: ActionResult;
    try {
      actionResult = await this.run(action, timeout);
    } catch (err) {
      actionResult = this.classify(err);
    }
    return { actionResult, observation: await this.observe() };
  }

  private async run(a: Action, timeout: number): Promise<ActionResult> {
    const page = this.cur();
    const el = (ref: number) => this.resolve(page, ref);
    switch (a.type) {
      case 'navigate': {
        let host: string;
        try { host = new URL(a.url).hostname; } catch { return fail('BAD_ACTION', `Invalid URL: ${a.url}`); }
        if (!hostAllowed(host, this.allowed) && !isLoopbackHost(host)) {
          return fail('NAV_BLOCKED', `${host} is not in this run's allowlist (${this.allowed.join(', ')}).`);
        }
        await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout });
        await settle(page);
        return { ok: true };
      }
      case 'click': {
        const loc = await el(a.ref); if ('error' in loc) return loc.error;
        await loc.locator.click({ button: a.button ?? 'left', clickCount: a.doubleClick ? 2 : 1, timeout });
        await settle(page);
        return { ok: true };
      }
      case 'type': {
        const loc = await el(a.ref); if ('error' in loc) return loc.error;
        const text = this.substitute(a.text);
        if (typeof text !== 'string') return fail('BAD_ACTION', `Unknown credential placeholder {{cred:${text.missing}}}`);
        if (a.clear !== false) await loc.locator.fill(text, { timeout });
        else await loc.locator.pressSequentially(text, { timeout });
        if (a.submit) { await loc.locator.press('Enter', { timeout }); await settle(page); }
        return { ok: true };
      }
      case 'press': await page.keyboard.press(a.key); await settle(page); return { ok: true };
      case 'select': {
        const loc = await el(a.ref); if ('error' in loc) return loc.error;
        await loc.locator.selectOption(a.value !== undefined ? { value: a.value } : { label: a.label ?? '' }, { timeout });
        return { ok: true };
      }
      case 'hover': {
        const loc = await el(a.ref); if ('error' in loc) return loc.error;
        await loc.locator.hover({ timeout });
        return { ok: true };
      }
      case 'scroll': {
        if (a.ref !== undefined) {
          const loc = await el(a.ref); if ('error' in loc) return loc.error;
          await loc.locator.scrollIntoViewIfNeeded({ timeout });
        } else {
          const dy = (a.direction === 'up' ? -1 : 1) * Math.min(Math.max(a.amount ?? 600, 1), 5000);
          await page.mouse.wheel(0, dy);
        }
        return { ok: true };
      }
      case 'wait': {
        const t = Math.min(Math.max(a.timeoutMs ?? 10000, 100), 10000);
        if (a.forText) await page.getByText(a.forText, { exact: false }).first().waitFor({ state: 'visible', timeout: t });
        else if (a.forRef !== undefined) {
          const loc = await el(a.forRef); if ('error' in loc) return loc.error;
          await loc.locator.waitFor({ state: 'visible', timeout: t });
        } else await page.waitForTimeout(Math.min(Math.max(a.ms ?? 500, 0), 10000));
        return { ok: true };
      }
      case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout }); await settle(page); return { ok: true };
      case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout }); await settle(page); return { ok: true };
      case 'observe': return { ok: true };
      default: return fail('BAD_ACTION', `Unknown action type: ${(a as { type?: string }).type}`);
    }
  }

  private substitute(text: string): string | { missing: string } {
    let missing: string | undefined;
    const out = text.replace(SECRET_RE, (_m, label: string) => {
      const v = this.opts.secrets?.[label];
      if (v === undefined) { missing = label; return ''; }
      return v;
    });
    return missing !== undefined ? { missing } : out;
  }

  private async resolve(page: Page, ref: number): Promise<{ locator: ReturnType<Page['locator']> } | { error: ActionResult }> {
    if (!Number.isInteger(ref) || ref < 0 || ref >= this.lastRefCount) {
      return { error: fail('STALE_REF', `ref ${ref} is not in the last observation (0..${this.lastRefCount - 1}). Observe again.`) };
    }
    const locator = page.locator(`[data-dbg-ref="${ref}"]`).first();
    if (await locator.count() === 0) return { error: fail('NOT_FOUND', `ref ${ref} is no longer on the page. Observe again.`) };
    return { locator };
  }

  private classify(err: unknown): ActionResult {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    if (this.blocked.length > 0) return fail('NAV_BLOCKED', `Navigation to ${[...new Set(this.blocked)].join(', ')} was blocked by the allowlist.`);
    if (/Timeout|timeout/.test(msg)) return fail('TIMEOUT', msg);
    if (/not visible|not attached|hidden/.test(msg)) return fail('NOT_VISIBLE', msg);
    return fail('FAILED', msg);
  }

  async observe(): Promise<Observation> {
    const page = this.cur();
    const delta = {
      console: this.consoleBuf.splice(0).slice(0, 30),
      failedRequests: this.failedBuf.splice(0).slice(0, 30),
      dialogs: this.dialogBuf.splice(0),
    };
    if (this.closed || page.isClosed()) return { ...emptyObservation(), delta };
    let digest: { elements: ElementInfo[]; text: string } = { elements: [], text: '' };
    try {
      digest = await page.evaluate(`${DIGEST_SCRIPT}(${JSON.stringify({ max: MAX_ELEMENTS, maxText: MAX_TEXT })})`) as typeof digest;
    } catch { /* mid-navigation: return what we have */ }
    this.lastRefCount = digest.elements.length;
    let screenshotBase64: string | undefined;
    try { screenshotBase64 = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64'); } catch { /* ignore */ }
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      elements: digest.elements,
      text: digest.text,
      ...(screenshotBase64 ? { screenshotBase64, screenshotMime: 'image/jpeg' as const } : {}),
      delta,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeBrowser().catch(() => {});
  }
}

function fail(code: ActionErrorCode, message: string): ActionResult {
  return { ok: false, error: { code, message } };
}

function stripQuery(u: string): string {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return u.slice(0, 200); }
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
}

function emptyObservation(): Observation {
  return { url: '', title: '', elements: [], text: '', delta: { console: [], failedRequests: [], dialogs: [] } };
}
