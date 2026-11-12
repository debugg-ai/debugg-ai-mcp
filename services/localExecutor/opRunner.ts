/**
 * OpRunner: executes ONE Command in real local Chrome (playwright-core) and returns a
 * CommandResult. Thin by design: Playwright's own semantics (auto-wait, actionability)
 * do the work; this layer serialises, enforces the allowlist on every navigation hop,
 * substitutes credential placeholders locally, redacts, and reports page events.
 */
import fs from 'node:fs';
import path from 'node:path';
import { launch, localBrowserEnabled, LocalBrowserError, hostAllowed, resolveAllowedDomains, debuggHome, ensurePrivateDir } from '../localBrowser.js';
import { installNavigationGuard, isLoopbackHost } from '../navigationGuard.js';
import { OPS, type Command, type CommandResult, type ErrorCode, type ExecError, type ExecEvent, type Observation } from './ops.js';
import type { BrowserContext, Dialog, Locator, Page } from 'playwright-core';

export interface OpRunnerOptions {
  /** Hostnames (with subdomains) the session may navigate to. Loopback is always allowed. Never empty for useProfile. */
  allowedDomains: string[];
  headless?: boolean;
  useProfile?: boolean;
  /** `{{cred:label}}` placeholder values. Substituted locally in fill/type/press args; never echoed or sent. */
  secrets?: Record<string, string>;
  /** local_only: screenshots are written to disk and only a 1x1 PNG goes to the cloud. */
  screenshots?: 'cloud' | 'local_only';
  viewport?: { width: number; height: number };
  maxInlineBytes?: number;
  signal?: AbortSignal;
  defaultTimeoutMs?: number;
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
const SECRET_RE = /\{\{cred:([^}]+)\}\}/g;
const PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iqLiWAAAAABJRU5ErkJggg==';

class OpError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly retryable = false) { super(message); }
}

export class OpRunner {
  private events: ExecEvent[] = [];
  private emit(e: DistributiveOmit<ExecEvent, 'ts'>): void { this.events.push({ ...e, ts: Date.now() } as ExecEvent); }
  private pages = new Map<string, Page>();
  private ids = new Map<Page, string>();
  private nextPage = 1;
  private currentId = '';
  private closed = false;
  private blocked: string[] = [];

  private constructor(private readonly context: BrowserContext, private readonly closeBrowser: () => Promise<void>, private readonly opts: OpRunnerOptions) {}

  static supportedOps(): readonly string[] { return OPS; }

  static async open(opts: OpRunnerOptions): Promise<OpRunner> {
    if (!localBrowserEnabled()) {
      throw new LocalBrowserError('Local browser mode is off. Set DEBUGGAI_LOCAL_BROWSER=1 in the MCP server environment to allow it.', 'LOCAL_BROWSER_DISABLED');
    }
    const allowed = opts.useProfile ? resolveAllowedDomains(opts.allowedDomains) : opts.allowedDomains;
    if (allowed.length === 0) {
      throw new LocalBrowserError('A local session needs a non-empty domain allowlist (allowedDomains, or DEBUGGAI_PROFILE_ALLOWED_DOMAINS for profile sessions).', 'ALLOWLIST_REQUIRED');
    }
    const { context, close } = await launch({ headless: opts.headless !== false, useProfile: !!opts.useProfile });
    try {
      const r = new OpRunner(context, close, { ...opts, allowedDomains: allowed });
      const vp = opts.viewport ?? { width: 1280, height: 800 };
      const first = context.pages()[0] ?? await context.newPage();
      await first.setViewportSize(vp).catch(() => {});
      await installNavigationGuard(context, allowed, (h) => r.blocked.push(h));
      r.register(first);
      context.on('page', (pg) => { const id = r.register(pg); r.emit({ type: 'popup', page_id: id, url: pg.url() }); });
      opts.signal?.addEventListener('abort', () => { void r.close(); }, { once: true });
      return r;
    } catch (err) { await close().catch(() => {}); throw err; }
  }

  private register(pg: Page): string {
    const id = `p${this.nextPage++}`;
    this.pages.set(id, pg); this.ids.set(pg, id); this.currentId = id;
    pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') this.emit({ type: 'console', level: m.type(), text: m.text().slice(0, 500) }); });
    pg.on('pageerror', (e) => this.emit({ type: 'console', level: 'error', text: e.message.slice(0, 500) }));
    pg.on('response', (r) => { if (r.status() >= 400) this.emit({ type: 'request_failed', url: stripQuery(r.url()), status: r.status() }); });
    pg.on('requestfailed', (r) => this.emit({ type: 'request_failed', url: stripQuery(r.url()), status: 'aborted' }));
    pg.on('dialog', (d: Dialog) => {
      this.emit({ type: 'dialog', dialog: d.type(), message: d.message().slice(0, 300) });
      void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {});
    });
    pg.on('download', (d) => this.emit({ type: 'download', url: stripQuery(d.url()), filename: d.suggestedFilename() }));
    pg.on('close', () => { this.pages.delete(id); this.ids.delete(pg); if (this.currentId === id) this.currentId = [...this.pages.keys()].pop() ?? ''; });
    return id;
  }

  private page(cmd: Command): Page {
    const id = cmd.target?.page_id || this.currentId;
    const pg = this.pages.get(id);
    if (!pg || pg.isClosed()) throw new OpError('invalid_args', `No open page${id ? ` with id ${id}` : ''}.`);
    return pg;
  }

  private locator(pg: Page, cmd: Command): Locator {
    const sel = cmd.target?.selector;
    if (!sel) throw new OpError('invalid_args', `${cmd.op} needs target.selector.`);
    let scope: Page | ReturnType<Page['frameLocator']> = pg;
    for (const f of cmd.target?.frame ?? []) scope = (scope as Page).frameLocator(f);
    return scope.locator(sel);
  }

  async execute(cmd: Command): Promise<CommandResult> {
    const t0 = Date.now();
    this.blocked = [];
    const base = { command_id: cmd.id };
    if (this.closed) return { ...base, ok: false, duration_ms: 0, error: { code: 'cancelled', message: 'executor is closed', retryable: false } };
    if (!(OPS as readonly string[]).includes(cmd.op)) {
      return { ...base, ok: false, duration_ms: 0, error: { code: 'unsupported_op', message: `Unsupported op: ${cmd.op}`, retryable: false, detail: { op: cmd.op } } };
    }
    let observation: Observation | undefined;
    let error: ExecError | undefined;
    let abortTimer: NodeJS.Timeout | undefined;
    try {
      const work = this.run(cmd);
      const guarded = cmd.deadline_ms
        ? Promise.race([work, new Promise<never>((_r, rej) => { abortTimer = setTimeout(() => rej(new OpError('timeout', `Command exceeded deadline_ms=${cmd.deadline_ms}.`)), cmd.deadline_ms); })])
        : work;
      observation = await guarded;
    } catch (err) {
      error = await this.toError(err, cmd);
    } finally { if (abortTimer) clearTimeout(abortTimer); }
    const pg = this.pages.get(cmd.target?.page_id || this.currentId);
    const out: CommandResult = {
      ...base, ok: !error, duration_ms: Date.now() - t0,
      url: pg && !pg.isClosed() ? pg.url() : undefined,
      title: pg && !pg.isClosed() ? await pg.title().catch(() => undefined) : undefined,
      events: this.events.splice(0).slice(0, 100),
      ...(observation ? { observation } : {}),
      ...(error ? { error } : {}),
    };
    return out;
  }

  private sub(v: unknown): string {
    const s = typeof v === 'string' ? v : String(v ?? '');
    return s.replace(SECRET_RE, (_m, label: string) => {
      const val = this.opts.secrets?.[label];
      if (val === undefined) throw new OpError('invalid_args', `Unknown credential placeholder {{cred:${label}}}.`);
      return val;
    });
  }

  private to(cmd: Command): number | undefined {
    const t = cmd.args?.timeout_ms;
    return typeof t === 'number' ? t : this.opts.defaultTimeoutMs;
  }

  private async run(cmd: Command): Promise<Observation> {
    const a = cmd.args ?? {};
    const timeout = this.to(cmd);
    const act: Observation = { kind: 'action' };
    switch (cmd.op) {
      case 'goto': {
        const pg = this.page(cmd);
        const url = String(a.url ?? '');
        let host: string;
        try { host = new URL(url).hostname; } catch { throw new OpError('invalid_args', `Invalid URL: ${url}`); }
        if (!hostAllowed(host, this.opts.allowedDomains) && !isLoopbackHost(host)) throw new OpError('domain_blocked', `${host} is not in this session's allowlist (${this.opts.allowedDomains.join(', ')}).`, false);
        const resp = await pg.goto(url, { waitUntil: (a.wait_until as 'load' | 'domcontentloaded' | 'networkidle' | 'commit') ?? 'domcontentloaded', timeout });
        return { kind: 'action', value: { status: resp?.status() ?? null } };
      }
      case 'back': await this.page(cmd).goBack({ waitUntil: 'domcontentloaded', timeout }); return act;
      case 'forward': await this.page(cmd).goForward({ waitUntil: 'domcontentloaded', timeout }); return act;
      case 'reload': await this.page(cmd).reload({ waitUntil: 'domcontentloaded', timeout }); return act;
      case 'evaluate': {
        const pg = this.page(cmd);
        const expr = String(a.expression ?? '');
        const value = cmd.target?.selector
          ? await this.locator(pg, cmd).first().evaluate(expr as never, a.arg as never, { timeout })
          : await pg.evaluate(expr as never, a.arg as never);
        return { kind: 'eval', value: value === undefined ? null : value };
      }
      case 'click': await this.locator(this.page(cmd), cmd).first().click({ timeout, button: a.button as 'left' | undefined, force: a.force as boolean | undefined, delay: a.delay as number | undefined, position: a.position as { x: number; y: number } | undefined }); return act;
      case 'dblclick': await this.locator(this.page(cmd), cmd).first().dblclick({ timeout, force: a.force as boolean | undefined }); return act;
      case 'fill': await this.locator(this.page(cmd), cmd).first().fill(this.sub(a.value ?? a.text), { timeout }); return act;
      case 'type': await this.locator(this.page(cmd), cmd).first().pressSequentially(this.sub(a.text ?? a.value), { timeout, delay: a.delay as number | undefined }); return act;
      case 'press': {
        const key = this.sub(a.key);
        if (cmd.target?.selector) await this.locator(this.page(cmd), cmd).first().press(key, { timeout });
        else await this.page(cmd).keyboard.press(key);
        return act;
      }
      case 'hover': await this.locator(this.page(cmd), cmd).first().hover({ timeout }); return act;
      case 'select_option': {
        const v = a.values ?? a.value ?? a.label;
        await this.locator(this.page(cmd), cmd).first().selectOption(v as string | string[], { timeout });
        return act;
      }
      case 'check': await this.locator(this.page(cmd), cmd).first().check({ timeout }); return act;
      case 'uncheck': await this.locator(this.page(cmd), cmd).first().uncheck({ timeout }); return act;
      case 'focus': await this.locator(this.page(cmd), cmd).first().focus({ timeout }); return act;
      case 'scroll': {
        const pg = this.page(cmd);
        if (cmd.target?.selector) await this.locator(pg, cmd).first().scrollIntoViewIfNeeded({ timeout });
        else await pg.mouse.wheel(Number(a.x ?? 0), Number(a.y ?? 600));
        return act;
      }
      case 'wait_for_selector': await this.locator(this.page(cmd), cmd).first().waitFor({ state: (a.state as 'visible') ?? 'visible', timeout }); return act;
      case 'wait_for_load_state': await this.page(cmd).waitForLoadState((a.state as 'load') ?? 'load', { timeout }); return act;
      case 'wait_for_function': await this.page(cmd).waitForFunction(String(a.expression ?? '') as never, a.arg as never, { timeout }); return act;
      case 'query': return { kind: 'query', value: await this.query(this.locator(this.page(cmd), cmd).first(), String(a.kind ?? 'text'), a, timeout) };
      case 'query_all': {
        const loc = this.locator(this.page(cmd), cmd);
        const n = Math.min(await loc.count(), 500);
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) out.push(await this.query(loc.nth(i), String(a.kind ?? 'text'), a, timeout));
        return { kind: 'query', value: out };
      }
      case 'screenshot': return this.screenshot(cmd);
      case 'content': return { kind: 'content', value: await this.page(cmd).content() };
      case 'set_content': await this.page(cmd).setContent(String(a.html ?? ''), { timeout }); return act;
      case 'add_init_script': await this.context.addInitScript(String(a.script ?? '')); return act;
      case 'title': return { kind: 'query', value: await this.page(cmd).title() };
      case 'url': return { kind: 'query', value: this.page(cmd).url() };
      case 'set_viewport': await this.page(cmd).setViewportSize({ width: Number(a.w ?? a.width ?? 1280), height: Number(a.h ?? a.height ?? 800) }); return act;
      case 'new_page': {
        const pg = await this.context.newPage();
        const id = this.ids.get(pg) ?? this.register(pg);
        return { kind: 'action', value: { page_id: id } };
      }
      case 'list_pages': return { kind: 'query', value: [...this.pages.entries()].map(([id, p]) => ({ page_id: id, url: p.url(), current: id === this.currentId })) };
      case 'switch_page': {
        const id = String(a.page_id ?? cmd.target?.page_id ?? '');
        if (!this.pages.has(id)) throw new OpError('invalid_args', `No page ${id}.`);
        this.currentId = id; await this.pages.get(id)!.bringToFront().catch(() => {});
        return act;
      }
      case 'close_page': await this.page(cmd).close(); return act;
      default: throw new OpError('unsupported_op', `Unsupported op: ${cmd.op}`);
    }
  }

  private async query(loc: Locator, kind: string, a: Record<string, unknown>, timeout?: number): Promise<unknown> {
    switch (kind) {
      case 'count': return loc.count();
      case 'text': return loc.innerText({ timeout });
      case 'html': return loc.innerHTML({ timeout });
      case 'attr': return loc.getAttribute(String(a.name ?? ''), { timeout });
      case 'value': {
        const type = (await loc.getAttribute('type', { timeout }).catch(() => null))?.toLowerCase();
        return type === 'password' ? '' : loc.inputValue({ timeout });
      }
      case 'visible': return loc.isVisible();
      case 'enabled': return loc.isEnabled({ timeout });
      case 'checked': return loc.isChecked({ timeout });
      case 'box': return loc.boundingBox({ timeout });
      default: throw new OpError('invalid_args', `Unknown query kind: ${kind}`);
    }
  }

  private async screenshot(cmd: Command): Promise<Observation> {
    const a = cmd.args ?? {};
    const pg = this.page(cmd);
    const buf = cmd.target?.selector
      ? await this.locator(pg, cmd).first().screenshot({ type: 'png', timeout: this.to(cmd) })
      : await pg.screenshot({ type: 'png', fullPage: !!a.full_page, timeout: this.to(cmd) });
    const dir = path.join(debuggHome(), 'captures');
    ensurePrivateDir(dir);
    const file = path.join(dir, `shot-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    if (this.opts.screenshots === 'local_only') {
      return { kind: 'screenshot', value: { base64: PX, local_path: file, redacted: true }, screenshot_ref: null };
    }
    if (cmd.upload_url) {
      const res = await fetch(cmd.upload_url, { method: 'PUT', headers: { 'content-type': cmd.upload_content_type ?? 'image/png' }, body: new Uint8Array(buf) });
      if (!res.ok) throw new OpError('internal', `Screenshot upload failed: HTTP ${res.status}`, true);
      return { kind: 'screenshot', value: { local_path: file }, screenshot_ref: cmd.upload_url.split('?')[0] };
    }
    if (buf.length > (this.opts.maxInlineBytes ?? 1_000_000)) {
      throw new OpError('invalid_args', `Screenshot is ${buf.length} bytes, over max_inline_bytes, and no upload_url was given.`);
    }
    return { kind: 'screenshot', value: { base64: buf.toString('base64'), local_path: file }, screenshot_ref: null };
  }

  private async toError(err: unknown, cmd: Command): Promise<ExecError> {
    if (err instanceof OpError) return { code: err.code, message: err.message, retryable: err.retryable };
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    if (this.blocked.length > 0) return { code: 'domain_blocked', message: `Navigation to ${[...new Set(this.blocked)].join(', ')} was blocked by the allowlist.`, retryable: false };
    if (/Target (page, context or browser )?has been closed|browser has been closed|Page crashed/i.test(msg)) return { code: 'browser_crashed', message: msg, retryable: false };
    if (/net::ERR|NS_ERROR|Navigation failed|ERR_/i.test(msg)) return { code: 'navigation_failed', message: msg, retryable: true };
    if (/not visible|not attached|hidden|not stable|intercepts pointer/i.test(msg)) return { code: 'not_visible', message: msg, retryable: true };
    if (/strict mode violation|waiting for locator|No node found/i.test(msg) || err instanceof Error && err.name === 'TimeoutError') {
      if (cmd.target?.selector) {
        try {
          const n = await this.locator(this.page(cmd), cmd).count();
          if (n === 0) return { code: 'target_not_found', message: msg, retryable: true };
        } catch { /* fall through */ }
      }
      return { code: 'timeout', message: msg, retryable: true };
    }
    return { code: 'internal', message: msg, retryable: false };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeBrowser().catch(() => {});
  }
}

function stripQuery(u: string): string {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return u.slice(0, 200); }
}
