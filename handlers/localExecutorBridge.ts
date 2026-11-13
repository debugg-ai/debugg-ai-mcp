/**
 * check_app_in_browser with browser:'local' (epic m7un). The cloud workflow runs as
 * usual but its page calls are served by the Chrome on THIS machine through the
 * Executor API v1 (sentinal docs/local-executor-api-design.md). This module owns the
 * MCP side: create the session, hold Chrome, attach + serve commands while the
 * workflow executes, tear down. The handler only calls prepare / begin / end.
 */
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { localBrowserEnabled, LocalBrowserError, LOCAL_UNAVAILABLE_MESSAGE, findChrome, resolveAllowedDomains } from '../services/localBrowser.js';
import { OpRunner } from '../services/localExecutor/opRunner.js';
import { runExecutorSession, type SessionEnd } from '../services/localExecutor/session.js';
import { HttpExecutorTransport } from '../services/localExecutor/httpTransport.js';
import { generateSessionKeys, type SealedEnvelope } from '../services/localExecutor/credentialBox.js';
import type { SessionLimits } from '../services/localExecutor/ops.js';
import type { TestPageChangesInput } from '../types/index.js';
import type { DebuggAIServerClient } from '../services/index.js';

export interface LocalRun {
  sessionId: string;
  /** Call once the workflow execution has been queued; starts serving commands. */
  begin(): void;
  /** Stop serving, close Chrome. Safe to call without begin(). */
  end(): Promise<{ ended: SessionEnd | 'not_started'; commandsRun: number }>;
}

/**
 * Passwords never go to the cloud for a local run: the workflow gets `{{cred:<label>}}`
 * and the real value stays here. Environment-stored credentials (credentialId/role)
 * live in the cloud and are not handled by this path yet.
 */
export function localizeCredentials(input: TestPageChangesInput): { input: TestPageChangesInput; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const ph = (label: string, password: string) => { secrets[label] = password; return `{{cred:${label}}}`; };
  const out: TestPageChangesInput = { ...input };
  if (input.username && input.password) out.password = ph(input.username, input.password);
  if (input.loginCredentials) {
    out.loginCredentials = input.loginCredentials.map((c) => ({ ...c, password: ph(c.label ?? c.username, c.password) }));
  }
  if (input.auth?.password && input.auth.username) {
    out.auth = { ...input.auth, password: ph(input.auth.username, input.auth.password) };
  }
  return { input: out, secrets };
}

/**
 * Local runs are a paid feature. The backend answers a plan that does not include them with
 * HTTP 402 (or a 403 whose code names the plan/entitlement) and a structured body; show its
 * message, upgrade link and docs link as they are and never retry. Returns undefined for any
 * other error.
 */
export function planRequiredFromError(err: unknown, mode: 'local' | 'remote' = 'local'): LocalBrowserError | undefined {
  const e = err as { statusCode?: number; response?: { status?: number; data?: unknown }; responseData?: unknown } | undefined;
  const status = e?.statusCode ?? e?.response?.status;
  const raw = (e?.responseData ?? e?.response?.data) as Record<string, unknown> | undefined;
  const body = (raw && typeof raw.error === 'object' && raw.error ? raw.error : raw) as Record<string, unknown> | undefined;
  const pick = (...keys: string[]) => { for (const k of keys) { const v = body?.[k]; if (typeof v === 'string' && v) return v; } return undefined; };
  const code = pick('code', 'error_code', 'errorCode');
  const planish = !!code && /plan|entitle|upgrade|subscription|not_included/i.test(code);
  if (status !== 402 && !(status === 403 && planish)) return undefined;
  const feature = pick('feature');
  const message = pick('error', 'message', 'detail') ?? (mode === 'remote' ? 'Cloud browsers are not included in your plan.' : 'This run is not included in your plan.');
  const upgradeUrl = pick('upgrade_url', 'upgradeUrl');
  const docsUrl = pick('docs_url', 'docsUrl');
  const required = body?.required_plans ?? body?.requiredPlans;
  // A plan without cloud browsers can still run in the caller's own Chrome, for free. Say how; never fall back silently.
  const alternative = mode === 'remote' ? 'Run it free in your own Chrome: install Chrome and call with browser: "local".' : undefined;
  const hasHint = /browser:\s*["']?local/i.test(message);
  const text = [message, alternative && !hasHint ? alternative : undefined, upgradeUrl ? `Upgrade: ${upgradeUrl}` : undefined, docsUrl ? `Docs: ${docsUrl}` : undefined].filter(Boolean).join(' ');
  return new LocalBrowserError(text, 'PLAN_REQUIRED', { upgradeUrl, docsUrl, ...(feature ? { feature } : {}), ...(required ? { requiredPlans: required } : {}), ...(alternative ? { alternative } : {}) });
}

/**
 * Which browser runs this call. An explicit `browser` always wins. Unset: your own Chrome when it is
 * installed, the server is not the hosted one, or the call asks for something only local can do
 * (useProfile); otherwise the cloud browser.
 */
export function chooseBrowser(input: Pick<TestPageChangesInput, 'browser' | 'useProfile'>, env?: { chrome?: boolean; hosted?: boolean }): { mode: 'local' | 'remote'; auto: boolean } {
  if (input.browser === 'local') return { mode: 'local', auto: false };
  if (input.browser === 'remote') return { mode: 'remote', auto: false };
  if (input.useProfile) return { mode: 'local', auto: false }; // a profile only exists on this machine
  const hosted = env?.hosted ?? !localBrowserEnabled();
  const chrome = env?.chrome ?? !!findChrome();
  return hosted || !chrome ? { mode: 'remote', auto: false } : { mode: 'local', auto: true };
}

export function localAllowedDomains(input: TestPageChangesInput, startUrl: string): string[] {
  const startHost = (() => { try { return new URL(startUrl).hostname; } catch { return ''; } })();
  const extra = (input.extraOrigins ?? []).map((o) => { try { return new URL(/^\d+$/.test(o) ? `http://localhost:${o}` : o).hostname; } catch { return ''; } });
  if (input.useProfile) return resolveAllowedDomains(input.allowedDomains);
  return [startHost, ...(input.allowedDomains ?? []), ...extra].filter(Boolean);
}

interface CreateSessionResponse {
  sessionId: string;
  secret: string;
  /** Effective settings the server actually applied (request keys it does not allow overriding are ignored). */
  captureMode?: 'cloud' | 'local_only';
  headless?: boolean;
  limits?: Partial<{ heartbeatS: number; leaseS: number; maxInlineBytes: number; maxBatch: number; maxInflight: number }>;
  /** Stored environment credentials, password sealed to our session public key. */
  credentials?: Array<{ label: string; username?: string; sealed: SealedEnvelope }>;
}

export async function prepareLocalRun(args: {
  client: DebuggAIServerClient;
  input: TestPageChangesInput;
  startUrl: string;
  secrets: Record<string, string>;
  signal: AbortSignal;
  projectId?: string;
}): Promise<LocalRun> {
  const { client, input, startUrl, secrets, signal } = args;
  if (!localBrowserEnabled()) {
    throw new LocalBrowserError(LOCAL_UNAVAILABLE_MESSAGE, 'LOCAL_BROWSER_DISABLED');
  }
  const allowed = localAllowedDomains(input, startUrl);
  if (allowed.length === 0) {
    throw new LocalBrowserError('A profile session needs an allowlist of domains it may visit: pass allowedDomains or have the server owner set DEBUGGAI_PROFILE_ALLOWED_DOMAINS.', 'PROFILE_ALLOWLIST_REQUIRED');
  }
  const headless = input.headless !== false;
  const screenshotsMode = process.env.DEBUGGAI_LOCAL_SCREENSHOTS === 'local_only' ? 'local_only' : 'cloud';

  // Chrome starts while the session is being created and the workflow queued.
  // Mutable on purpose: stored credentials are decrypted into it once the session exists.
  const liveSecrets: Record<string, string> = { ...secrets };
  const keys = generateSessionKeys();
  const runnerP = OpRunner.open({ allowedDomains: allowed, headless, useProfile: !!input.useProfile, secrets: liveSecrets, screenshots: screenshotsMode, signal });
  runnerP.catch(() => {});
  let created: CreateSessionResponse;
  try {
    created = await client.tx!.post<CreateSessionResponse>('api/v1/executors/sessions', {
      executor: 'local',
      allowedDomains: allowed,
      headless,
      viewport: { w: 1280, h: 800 },
      capture: { screenshots: screenshotsMode },
      // Public half only. The private key never leaves this process.
      executorPublicKey: keys.publicKey,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
      ...(input.credentialRole ? { credentialRole: input.credentialRole } : {}),
    });
  } catch (err) {
    (await runnerP.catch(() => null))?.close();
    const planErr = planRequiredFromError(err);
    if (planErr) throw planErr;
    const status = (err as { response?: { status?: number }; statusCode?: number })?.response?.status ?? (err as { statusCode?: number })?.statusCode;
    if (status === 404) {
      throw new LocalBrowserError('The DebuggAI backend does not offer local browser execution yet (executor API not enabled for this account).', 'LOCAL_EXECUTOR_UNAVAILABLE');
    }
    throw err;
  }
  const runner = await runnerP;
  if (created.captureMode === 'cloud' || created.captureMode === 'local_only') runner.setCaptureMode(created.captureMode);
  if (typeof created.headless === 'boolean' && created.headless !== (headless !== false)) {
    logger.warn(`Server runs this session with headless=${created.headless}; the local browser was already launched with headless=${headless !== false}.`);
  }
  for (const c of created.credentials ?? []) {
    try {
      const pw = keys.open(c.sealed, created.sessionId);
      liveSecrets[c.label] = pw;
      // The backend names the placeholder after the label OR the username depending on the resolution path; accept both.
      if (c.username && !(c.username in liveSecrets)) liveSecrets[c.username] = pw;
    }
    catch (err) { logger.warn(`Could not open stored credential "${c.label}" (${err instanceof Error ? err.message : 'decrypt failed'})`); }
  }
  const limits: SessionLimits = {
    heartbeat_s: created.limits?.heartbeatS ?? 10,
    lease_s: created.limits?.leaseS ?? 45,
    max_inline_bytes: created.limits?.maxInlineBytes ?? 1_000_000,
    max_batch: created.limits?.maxBatch ?? 1,
    ...(created.limits?.maxInflight ? { max_inflight: created.limits.maxInflight } : {}),
  };
  const transport = new HttpExecutorTransport({
    baseUrl: config.api.baseUrl,
    authorization: `${config.api.tokenType === 'bearer' ? 'Bearer' : 'Token'} ${config.api.key}`,
    sessionId: created.sessionId,
    secret: created.secret,
  });
  runner.setUploader((url, ct, bytes) => transport.upload(url, ct, bytes));
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let running: Promise<{ ended: SessionEnd; commandsRun: number }> | undefined;
  return {
    sessionId: created.sessionId,
    begin() {
      running = runExecutorSession({
        transport, runner, limits, signal: stop.signal,
        attach: {
          executor_version: 'debugg-ai-mcp',
          ops_supported: OpRunner.supportedOps(),
          browser: { name: 'chrome', headless },
          profile: input.useProfile ? 'mcp_owned' : 'ephemeral',
          credential_labels: Object.keys(liveSecrets),
        },
      }).catch((err) => { logger.warn(`local executor session failed: ${err instanceof Error ? err.message : err}`); return { ended: 'lease_lost' as SessionEnd, commandsRun: 0 }; });
    },
    async end() {
      signal.removeEventListener('abort', onAbort);
      if (!running) { await runner.close(); return { ended: 'not_started' as const, commandsRun: 0 }; }
      stop.abort();
      return running;
    },
  };
}
