/**
 * Test Page Changes Handler
 * Executes the App Evaluation Workflow via the 4-step pattern:
 *   find template → execute → poll → result
 */

import {
  TestPageChangesInput,
  ToolResponse,
  ToolContext,
  ProgressCallback,
  meansDoNotLogIn,
} from '../types/index.js';
import { config } from '../config/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { fetchImageAsBase64, imageContentBlock, resourceLinkBlock, artifactResourceLinks } from '../utils/imageUtils.js';
import { DebuggAIServerClient } from '../services/index.js';
import { getEvalTemplateSlug } from '../services/workflows.js';
import { adaptVerdict, credentialSubstitutions } from '../services/verdictAdapter.js';
import { TunnelProvisionError, type TunnelProvision } from '../services/tunnels.js';
import {
  resolveTargetUrl,
  buildContext,
  findExistingTunnel,
  ensureTunnel,
  acquirePortRoute,
  releasePortRoute,
  sanitizeResponseUrls,
  touchTunnelById,
  retargetAuxiliaryUrl,
} from '../utils/tunnelContext.js';
import { randomUUID } from 'node:crypto';
import { detectRepoName } from '../utils/gitContext.js';
import { disposeUnhealthyTunnel } from '../utils/tunnelDisposition.js';
import { probeLocalPort, probeTunnelHealth, extractTunnelErrorCode } from '../utils/localReachability.js';
import type { TunnelHealthProbeResult } from '../utils/localReachability.js';
import { extractLocalhostPort, rewriteLocalhostInText } from '../utils/urlParser.js';
import {
  getCachedTemplateUuid,
  getCachedProjectUuid,
  invalidateTemplateCache,
  invalidateProjectCache,
} from '../utils/handlerCaches.js';
import { isTransientWorkflowError, transientReasonTag } from '../utils/transientErrors.js';
import { Telemetry, TelemetryEvents } from '../utils/telemetry.js';

const logger = new Logger({ module: 'testPageChangesHandler' });

// Bead kbxy: bounded retry on known transient backend signatures (Pydantic
// JSON parse errors, 502s, ECONNRESETs). Default 1 retry; env-overridable
// up to 3 to balance reliability vs quota cost. Conservative: only retries
// on documented transient patterns (utils/transientErrors.ts).
function getMaxTransientRetries(): number {
  const raw = process.env.DEBUGGAI_TRANSIENT_RETRIES;
  if (raw === undefined || raw === '') return 1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(n, 3);
}

// Bug z15n: scan run evidence for the tunnel server's interstitial marker. It is a
// stable, recognizable string the REMOTE BROWSER saw — positive evidence that it
// hit our tunnel's error page rather than the user's app. Non-string parts are
// serialized (the action trace is the usual carrier); a part we can't serialize
// is simply skipped — it is not evidence either way.
function findTunnelErrorMarker(parts: unknown[]): string | undefined {
  for (const part of parts) {
    if (part === undefined || part === null || part === '') continue;
    let text: string;
    try {
      text = typeof part === 'string' ? part : JSON.stringify(part) ?? '';
    } catch {
      continue;
    }
    const code = extractTunnelErrorCode(text);
    if (code) return code;
  }
  return undefined;
}

// Credentials ride in `env` and `contextData.auth` on the way out. Log which
// accounts a run was given — that is the diagnostic that matters when a run
// signs in as the wrong user — but never their passwords.
function redactEnv(env: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...env };
  if (out.password) out.password = '[REDACTED]';
  if (Array.isArray(out.taskCredentials)) {
    out.taskCredentials = out.taskCredentials.map((c: Record<string, any>) => ({
      username: c.username,
      ...(c.label ? { label: c.label } : {}),
      password: '[REDACTED]',
    }));
  }
  return out;
}

function redactAuth(auth: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!auth) return undefined;
  return auth.password ? { ...auth, password: '[REDACTED]' } : auth;
}

// Concurrency control — max 2 simultaneous browser checks.
// Additional requests queue and run when a slot opens.
const MAX_CONCURRENT = 2;
let running = 0;
const queue: Array<{ resolve: () => void }> = [];

async function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT) { running++; return; }
  await new Promise<void>((resolve) => queue.push({ resolve }));
}

function releaseSlot(): void {
  running--;
  const next = queue.shift();
  if (next) { running++; next.resolve(); }
}

export async function testPageChangesHandler(
  input: TestPageChangesInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  await acquireSlot();
  try {
    return await testPageChangesHandlerInner(input, context, progressCallback);
  } finally {
    releaseSlot();
  }
}

async function testPageChangesHandlerInner(
  input: TestPageChangesInput,
  context: ToolContext,
  rawProgressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('check_app_in_browser', input);

  // Bead 0bq: wrap the progress callback in a circuit-breaker so a single
  // client-side rejection of a stale progressToken (which would normally
  // throw up the stack and abort the handler, or — worse — arrive post-response
  // and tear down the stdio transport) is swallowed and disables further
  // emissions in this request.
  let progressDisabled = false;
  const progressCallback: ProgressCallback | undefined = rawProgressCallback
    ? async (update) => {
        if (progressDisabled) return;
        try {
          await rawProgressCallback(update);
        } catch (err) {
          progressDisabled = true;
          logger.warn('Progress emission failed; disabling further emissions for this request', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    : undefined;

  const client = new DebuggAIServerClient(config.api.key);
  await client.init();

  const originalUrl = resolveTargetUrl(input);
  let ctx = buildContext(originalUrl);
  let provision: TunnelProvision | undefined;

  // Cancellation is driven by the MCP request/transport lifecycle, not
  // process.stdin. The SDK aborts context.signal when the client cancels the
  // call OR the transport closes — e.g. an HTTP client drops the connection.
  // Under the stateless HTTP transport that is the ONLY signal we get: stdin is
  // not the transport, so the old stdin 'close' listener never fired and a
  // dropped client kept polling for up to ~10 min, holding one of just
  // MAX_CONCURRENT=2 slots. Wiring to context.signal cancels the poll and frees
  // the slot immediately.
  //
  // Bead 5er7: aborting the poll frees our slot but does NOT stop the BACKEND
  // execution — it runs on to its own contextData.timeoutSeconds (720), driving
  // a real browser session and burning quota with nobody reading the result.
  // cancelExecution() existed for exactly this and had zero callers. Cancel the
  // in-flight execution best-effort on abort.
  //
  // Contract for the cancel path: NEVER throw and NEVER await. The client is
  // already gone, so a failed cancel is not worth surfacing, and the abort path
  // must not delay slot release. Strictly fire-and-forget, rejection swallowed.
  let clientAborted = false;
  let currentExecutionUuid = '';
  const cancelCurrentExecution = () => {
    // HELD OFF BY DEFAULT (bead 5er7 / sentinal-wmzdf). Cancelling the backend
    // execution skips its browser teardown, so the BrowserSession row leaks
    // ACTIVE and permanently burns one of the company's 50 concurrency slots —
    // a net-negative trade vs. the pre-fix behaviour (poll aborts, backend runs
    // to its own 720s budget, then teardown runs and the slot is returned:
    // bounded and self-healing). Read at call time so the flag can be flipped
    // to 'true' the moment the backend runs teardown on cancel (sentinal-wmzdf).
    if (process.env.DEBUGGAI_CANCEL_ABANDONED_EXECUTIONS !== 'true') return;
    const uuid = currentExecutionUuid;
    if (!uuid) return;         // nothing queued yet — never POST cancel/<empty>/
    currentExecutionUuid = ''; // cancel any given execution at most once
    try {
      client.workflows?.cancelExecution(uuid).then(
        () => logger.info(`Cancelled abandoned execution ${uuid}`),
        (err) => logger.warn(`Best-effort cancel of abandoned execution ${uuid} failed: ${err}`),
      );
    } catch (err) {
      logger.warn(`Best-effort cancel of abandoned execution ${uuid} threw synchronously: ${err}`);
    }
  };

  // Unique per-call id for the shared port-route lock's holder bookkeeping
  // (§2.4) — reused for abort wiring purposes elsewhere in this handler.
  const callId = randomUUID();

  const abortController = new AbortController();
  const onAbort = () => {
    clientAborted = true;
    abortController.abort();
    progressDisabled = true; // client is gone — stop emitting
    cancelCurrentExecution();
  };
  const requestSignal = context.signal;
  if (requestSignal) {
    if (requestSignal.aborted) onAbort();
    else requestSignal.addEventListener('abort', onAbort, { once: true });
  }

  // Progress budget: 3 setup steps + 25 execution steps = 28 total
  const SETUP_STEPS = 3;
  const MAX_EXEC_STEPS = 25;
  const TOTAL_STEPS = SETUP_STEPS + MAX_EXEC_STEPS;

  try {
    // --- Tunnel: reuse existing or provision a fresh one ---
    if (ctx.isLocalhost) {
      // Bead 1om: pre-flight local port probe BEFORE committing to backend
      // provision + tunnel session. If the user's dev server isn't listening,
      // fail in ~1.5s with a structured error instead of burning 5 minutes
      // on a browser agent trying to reach a dead tunnel.
      const localPort = extractLocalhostPort(ctx.originalUrl);
      if (typeof localPort === 'number') {
        const probe = await probeLocalPort(localPort);
        if (!probe.reachable) {
          const payload = {
            error: 'LocalServerUnreachable',
            message: `No server listening on 127.0.0.1:${localPort}.`,
            detail: {
              port: localPort,
              probeCode: probe.code,
              probeDetail: probe.detail,
              elapsedMs: probe.elapsedMs,
            },
          };
          logger.warn(`Pre-flight port probe failed for ${ctx.originalUrl}: ${probe.code} in ${probe.elapsedMs}ms`);
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
        }
      }

      if (config.devMode) {
        // Dev mode: local backend can reach localhost directly — no tunnel needed.
        logger.info(`check_app_in_browser: dev mode — using localhost URL directly: ${ctx.originalUrl}`);
      } else {
        if (progressCallback) {
          await progressCallback({ progress: 1, total: TOTAL_STEPS, message: 'Provisioning secure tunnel for localhost...' });
        }

        const reused = findExistingTunnel(ctx);
        if (reused) {
          ctx = reused;
          logger.info(`Reusing tunnel: ${ctx.targetUrl} (id: ${ctx.tunnelId})`);
        } else {
          let tunnel;
          try {
            tunnel = await client.tunnels!.provisionWithRetry();
          } catch (provisionError) {
            const msg = provisionError instanceof Error ? provisionError.message : String(provisionError);
            const diag = provisionError instanceof TunnelProvisionError ? ` ${provisionError.diagnosticSuffix()}` : '';
            throw new Error(`Failed to provision tunnel for ${ctx.originalUrl}: ${msg}${diag}`);
          }
          provision = tunnel;
          try {
            ctx = await ensureTunnel(
              ctx,
              tunnel.tunnelKey,
              tunnel.tunnelId,
              tunnel.keyId,
              () => client.tunnels!.revoke(tunnel),
              // The provision IS the transport selection. Omitting it here is
              // not a no-op: without it ensureTunnel gets no relayUrl or
              // tunnelDomain at all, so the flagship tool cannot connect a
              // tunnel the backend just issued. The other three
              // handlers pass it; this one was missed.
              tunnel,
            );
          } catch (tunnelError) {
            const msg = tunnelError instanceof Error ? tunnelError.message : String(tunnelError);
            throw new Error(`Tunnel creation failed for ${ctx.originalUrl}: ${msg}`);
          }
          logger.info(`Tunnel ready: ${ctx.targetUrl} (id: ${ctx.tunnelId})`);
        }

        // §2.4: acquire this session's shared Caddy route for our port BEFORE
        // probing/dispatching — probing before the repoint is confirmed would
        // probe whatever port happened to be active a moment ago. Blocks here
        // (not just during the repoint) until any different-port holder in
        // this same session releases.
        ctx = await acquirePortRoute(ctx, {
          callId,
          signal: abortController.signal,
          onWaitProgress: progressCallback
            ? async (info) => {
                await progressCallback({
                  progress: 1,
                  total: TOTAL_STEPS,
                  message: `Waiting for shared tunnel — port ${info.blockingPort} is in use (waited ${Math.round(info.waitedMs / 1000)}s)...`,
                });
              }
            : undefined,
        });

        // Bead 1om: verify traffic actually flows through the tunnel. The
        // tunnel can be established (connect returns OK) yet refuse
        // to forward traffic — e.g., IPv4/IPv6 bind mismatch, or the dev
        // server died between the pre-flight probe and here. Catch it now,
        // in ~1s, not via a 5-minute browser-agent false-pass.
        if (ctx.targetUrl) {
          const health = await probeTunnelHealth(ctx.targetUrl);
          if (!health.healthy) {
            const payload = {
              error: 'TunnelTrafficBlocked',
              message: `Tunnel established; a request through it to 127.0.0.1:${extractLocalhostPort(ctx.originalUrl)} failed: ${health.detail ?? health.code}.`,
              detail: {
                code: health.code,
                status: health.status,
                tunnelErrorCode: health.tunnelErrorCode,
                elapsedMs: health.elapsedMs,
              },
            };
            logger.warn(`Tunnel health probe failed for ${ctx.targetUrl}: ${health.code} ${health.tunnelErrorCode ?? ''} in ${health.elapsedMs}ms`);
            // Evict ONLY on a code proving the endpoint is gone; every other
            // failure keeps the tunnel we are already paying for, because a
            // teardown+re-provision costs two billed hours and this probe cannot
            // tell a dead endpoint from a transient edge flake. See
            // utils/tunnelDisposition.ts for the allowlist and the evidence.
            disposeUnhealthyTunnel({ health, tunnelId: ctx.tunnelId, originalUrl: ctx.originalUrl });
            // Don't revoke the key on either branch: if we evicted, markTunnelDead's
            // owned path already revokes it; if we kept the tunnel, the key is that
            // live tunnel's own credential and revoking it would kill what we just
            // decided to preserve.
            provision = undefined;
            return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
          }
        }
      }
    }

    // --- Resolve template + project in parallel (both independent post-tunnel) ---
    if (progressCallback) {
      await progressCallback({ progress: 2, total: TOTAL_STEPS, message: 'Locating evaluation workflow template...' });
    }

    const repoName = input.repoName || detectRepoName();

    const [templateUuid, projectUuid] = await Promise.all([
      // Cache key = the dispatch slug so the cache key and the lookup can never
      // drift apart (bug clka: the key used to be a decoupled 'app evaluation'
      // literal while the lookup searched a different string).
      getCachedTemplateUuid(getEvalTemplateSlug(), async () => {
        return client.workflows!.findEvaluationTemplate();
      }),
      repoName
        ? getCachedProjectUuid(repoName, async (repo) => {
            try {
              return await client.findProjectByRepoName(repo);
            } catch (err) {
              logger.warn(`Failed to look up project for repo "${repo}": ${err}`);
              return null;
            }
          })
        : Promise.resolve(undefined),
    ]);

    if (!templateUuid) {
      throw new Error(`App Evaluation workflow template not found (slug "${getEvalTemplateSlug()}").`);
    }
    // Fail fast + actionable when project_id can't be resolved (pinned backend
    // semantics: project_id is required). Surfacing "link this repo to a
    // project" now — before executeWorkflow — beats letting a backend workflow
    // node fail mid-run several minutes into the evaluation.
    if (!projectUuid) {
      const payload = {
        error: 'ProjectRequired',
        message: repoName
          ? `No DebuggAI project found for repo "${repoName}".`
          : 'No git repository detected and no repoName passed.',
      };
      logger.warn(`check_app_in_browser: ${payload.message}`);
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
    }

    // --- Build context data (camelCase here — axiosTransport auto-converts to snake_case) ---
    const contextData: Record<string, any> = {
      targetUrl: ctx.targetUrl ?? originalUrl,
      // The goal is read by a browser in OUR cloud. A goal that still says
      // "go to http://localhost:3017" sends it to its own loopback, where it
      // gets connection refused and the run is recorded as the app failing —
      // with the tunnel working the whole time. Rewrite it onto the same
      // tunnel the targetUrl above uses.
      question: rewriteLocalhostInText(input.description, ctx.targetUrl),
    };
    if (projectUuid) {
      contextData.projectId = projectUuid;
    }
    contextData.headless = true; // D7: the MCP always runs headless — no opt-out.

    // Bead 56kd.6: forward the auth-precondition deep-link intent verbatim per
    // backend contract sentinal-k8x1f.8 (contextData.auth). Thin relay — express
    // intent + forward; the backend authenticates then navigates to deepUrl. Only
    // the fields the caller set are sent (camelCase here → snake_case on the wire).
    if (input.auth) {
      const auth: Record<string, any> = {};
      if (input.auth.environmentId) auth.environmentId = input.auth.environmentId;
      if (input.auth.precondition) auth.precondition = input.auth.precondition;
      // Bead go1m: entryUrl/deepUrl are URLs the run NAVIGATES, so they need the
      // same localhost→tunnel rewrite `url` and the goal text get
      // (contextData.targetUrl and contextData.question above).
      // Forwarded verbatim they reached the remote browser as literal localhost
      // and it dialled its own loopback: offscope_host + ERR_CONNECTION_REFUSED.
      for (const field of ['entryUrl', 'deepUrl'] as const) {
        const supplied = input.auth[field];
        if (!supplied) continue;
        const rewrite = retargetAuxiliaryUrl(ctx, supplied);
        if (!rewrite.ok) {
          const payload = {
            error: 'AuthUrlPortMismatch',
            message:
              `auth.${field} points at localhost:${rewrite.port}; url points at ` +
              `localhost:${rewrite.primaryPort}. One call tunnels one local port.`,
            detail: { field, authPort: rewrite.port, urlPort: rewrite.primaryPort, url: originalUrl },
          };
          logger.warn(`check_app_in_browser: ${payload.message}`);
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
        }
        auth[field] = rewrite.url;
        if (rewrite.rewritten) {
          logger.info(`check_app_in_browser: tunneled auth.${field} ${supplied} -> ${rewrite.url}`);
        }
      }
      // WHICH account the precondition logs in as. Absent → the environment's
      // default credential (the pre-existing behaviour, correct for a caller
      // that named nobody).
      if (input.auth.username) auth.username = input.auth.username;
      if (input.auth.password) auth.password = input.auth.password;
      if (Object.keys(auth).length > 0) contextData.auth = auth;
    }

    // --- Build env (credentials/environment) ---
    const env: Record<string, any> = {};
    if (input.environmentId) env.environmentId = input.environmentId;
    if (input.credentialId) env.credentialId = input.credentialId;
    if (input.credentialRole) env.credentialRole = input.credentialRole;
    if (input.username) env.username = input.username;
    if (input.password) env.password = input.password;
    // Accounts for logins the agent hits mid-task. The backend keys these by
    // username so the agent can sign in as the one the task names, instead of
    // its only login affordance filling the environment's stored account.
    if (input.loginCredentials && input.loginCredentials.length > 0) {
      env.taskCredentials = input.loginCredentials.map(c => ({
        username: c.username,
        password: c.password,
        ...(c.label ? { label: c.label } : {}),
      }));
    }
    // Only send the opt-out when it's actually an opt-out — omitting it keeps
    // the default (environment credentials remain available as a fallback).
    if (input.useEnvironmentCredentials === false) {
      env.useEnvironmentCredentials = false;
    }
    // sentinal-oj7dp.3: opting out of the environment's credentials WITHOUT naming
    // an account means "do not log in" — say so in the language the backend already
    // speaks instead of leaving auth_mode on its 'auto' default. On 'auto' the auth
    // subworkflow hunts for a login on a page that needs none: measured 2026-08-18,
    // a public-homepage check spent 38 of its 111 seconds following the site's login
    // link to a sibling host, submitting the environment's default credential three
    // times, and parking the browser on a login screen the run was then graded
    // against (execution 2c787273). no_auth short-circuits that cleanly and marks
    // the run auth.skipped, which is explicitly NOT an auth failure (sentinal-76f8y.12).
    if (meansDoNotLogIn(input)) {
      contextData.auth_mode = 'no_auth';
    }
    // Same rule for the session opt-out: send it only when it IS one, so the
    // default (reuse a warm session when one exists for this account) is
    // expressed by absence rather than by an explicit false.
    if (input.freshSession === true) {
      env.freshSession = true;
    }

    // --- Execute ---
    // Log the SHAPE of env, never its secrets. It now carries per-account
    // passwords (taskCredentials), and this log line is not run through the
    // logger's shallow top-level redaction.
    logger.info('Sending contextData', {
      contextData: { ...contextData, auth: redactAuth(contextData.auth) },
      env: Object.keys(env).length > 0 ? redactEnv(env) : undefined,
    });
    if (progressCallback) {
      await progressCallback({ progress: 3, total: TOTAL_STEPS, message: 'Queuing workflow execution...' });
    }

    // --- Execute + Poll (with bounded retry on transient errors, bead kbxy) ---
    // Progress phases (per attempt):
    //   1-3:   MCP setup (tunnel, template, queue) — already sent above
    //   4-6:   Backend setup (trigger, browser.setup, subworkflow starting)
    //   7-27:  Agent steps (mapped from state.stepsTaken)
    //   28:    Complete
    const BACKEND_SETUP_END = 6;
    const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
    const MAX_RETRIES = getMaxTransientRetries();

    let executeResponse: import('../services/workflows.js').WorkflowExecuteResponse | undefined;
    let executionUuid = '';
    let finalExecution: import('../services/workflows.js').WorkflowExecution | undefined;
    let attempt = 0;

    while (true) {
      attempt++;

      if (attempt > 1) {
        // Retry path — emit telemetry + progress notification + brief backoff.
        Telemetry.capture(TelemetryEvents.WORKFLOW_TRANSIENT_RETRY, {
          tool: 'check_app_in_browser',
          attempt,
          reason: transientReasonTag(finalExecution),
          previousExecutionId: executionUuid,
          previousErrorMessage: finalExecution?.errorMessage?.slice(0, 200),
          previousStateError: finalExecution?.state?.error?.slice(0, 200),
        });
        if (progressCallback) {
          await progressCallback({
            progress: SETUP_STEPS,
            total: TOTAL_STEPS,
            message: `Transient backend error — retrying (attempt ${attempt}/${MAX_RETRIES + 1})...`,
          });
        }
        await new Promise(r => setTimeout(r, 1000 * (attempt - 1)));
      }

      executeResponse = await client.workflows!.executeWorkflow(
        templateUuid,
        contextData,
        Object.keys(env).length > 0 ? env : undefined,
      );
      executionUuid = executeResponse.executionUuid;
      // Bead 5er7: this is now the execution an abort must cancel (a retry moves
      // the target forward; the previous attempt already reached a terminal
      // state, so there is nothing to cancel there).
      currentExecutionUuid = executionUuid;
      logger.info(`Execution queued: ${executionUuid}${attempt > 1 ? ` (retry ${attempt - 1}/${MAX_RETRIES})` : ''}`);

      // The abort can fire BEFORE anything is queued — while provisioning the
      // tunnel or resolving the template — and there is no abort check between
      // there and here. Without this, a client that dropped during setup still
      // gets a ~12-minute browser run queued on its behalf and abandoned.
      if (clientAborted) cancelCurrentExecution();

      // Closure state — reset PER ATTEMPT so progress numbers don't double-count
      // across retries.
      let lastStepsTaken = 0;
      let observedMaxSteps = MAX_EXEC_STEPS;

      finalExecution = await client.workflows!.pollExecution(executionUuid, async (exec) => {
      // Keep the tunnel alive while the workflow is actively running
      if (ctx.tunnelId) touchTunnelById(ctx.tunnelId);

      const nodes = exec.nodeExecutions ?? [];
      const stepsTaken = Math.max(
        nodes.filter(n => n.nodeType === 'brain.step').length,
        exec.state?.stepsTaken ?? 0
      );

      if (stepsTaken !== lastStepsTaken) {
        lastStepsTaken = stepsTaken;
        logger.info(`Execution status: ${exec.status}, nodes: ${nodes.length}, steps: ${stepsTaken}`);
      }

      if (!progressCallback) return;

      // Bead 0bq: emit the final "Complete:" progress INSIDE this callback
      // when terminal status is detected. pollExecution will return on the
      // next line (line 183 in services/workflows.ts), so there's no
      // post-pollExecution progress emission that could race the response.
      if (TERMINAL_STATUSES.has(exec.status)) {
        // Status only: state.outcome is an internal value and can be one the
        // user-facing verdict retired ('inconclusive', 'unverified').
        await progressCallback({
          progress: TOTAL_STEPS,
          total: TOTAL_STEPS,
          message: `Complete: ${exec.status}`,
        });
        return;
      }

      // --- Compute progress number ---
      let execProgress: number;
      let message: string;

      if (stepsTaken > 0) {
        // Agent is actively stepping — map into slots 7..27
        if (stepsTaken > observedMaxSteps) observedMaxSteps = stepsTaken + 5;
        const stepSlots = TOTAL_STEPS - BACKEND_SETUP_END - 1; // 21 slots
        execProgress = BACKEND_SETUP_END + Math.max(1, Math.round((stepsTaken / observedMaxSteps) * stepSlots));
        execProgress = Math.min(execProgress, TOTAL_STEPS - 1);

        // Use state.currentAction for the message (backend sends intent + actionType)
        const ca = (exec.state as any)?.currentAction;
        if (ca?.intent) {
          const action = ca.actionType ?? ca.action_type ?? 'working';
          message = `Step ${stepsTaken}: [${action}] ${ca.intent}`;
        } else {
          message = `Agent evaluating... (step ${stepsTaken})`;
        }
      } else {
        // No agent steps yet — show backend setup progress from node transitions
        const hasSubworkflow = nodes.some(n => n.nodeType === 'subworkflow.run');
        const hasBrowserSetup = nodes.some(n => n.nodeType === 'browser.setup');
        const browserReady = nodes.some(n => n.nodeType === 'browser.setup' && n.status === 'success');

        if (browserReady || hasSubworkflow) {
          execProgress = BACKEND_SETUP_END;
          message = 'Browser ready, agent starting...';
        } else if (hasBrowserSetup) {
          execProgress = SETUP_STEPS + 2;
          message = 'Launching browser...';
        } else if (nodes.length > 0) {
          execProgress = SETUP_STEPS + 1;
          message = 'Workflow triggered, preparing...';
        } else {
          execProgress = SETUP_STEPS + 1;
          message = 'Waiting for execution to start...';
        }
      }

      await progressCallback({ progress: execProgress, total: TOTAL_STEPS, message });
    }, abortController.signal);

      // Bead 5er7: pollExecution returned, so the execution reached a terminal
      // state — there is nothing left to cancel and a late abort (while we shape
      // the response) must not POST a cancel for finished work. EXCEPTION: on a
      // poll-deadline timeout the execution may still be running backend-side,
      // so keep it cancellable.
      if (!finalExecution.timedOut) currentExecutionUuid = '';

      // Decide retry vs exit: only retry on documented transient signatures
      // AND while we still have budget. Otherwise break and surface whatever
      // result the agent reached.
      if (attempt > MAX_RETRIES) break;
      // A poll-deadline timeout (bead 56kd.3) is never retried — surface the
      // partial result instead of burning another 10 minutes.
      if (finalExecution.timedOut) break;
      if (!isTransientWorkflowError(finalExecution)) break;
      logger.warn(
        `Transient backend error detected (${transientReasonTag(finalExecution) ?? 'unknown'}) — ` +
        `retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
      );
    }

    const duration = Date.now() - startTime;

    // --- Format result ---
    const nodes = finalExecution.nodeExecutions ?? [];
    // subworkflow.run carries an inline base64 screenshot on some graph shapes;
    // only used for the image block below.
    const subworkflowNode = nodes.find(n => n.nodeType === 'subworkflow.run');

    // --- Relay the backend's explicit verdict (bead 56kd.2) ---
    // ONE adapter owns the backend-field → MCP mapping (services/verdictAdapter).
    // On a poll-deadline timeout (bead 56kd.3) pollExecution returns the last
    // observed execution flagged `timedOut`; force outcome 'timeout' since there
    // is no terminal backend verdict.
    const timedOut = finalExecution.timedOut === true;
    const verdict = adaptVerdict(finalExecution, {
      outcomeOverride: timedOut ? 'timeout' : undefined,
      // real numbers from the deadline path, so the reason is a record of what
      // we observed rather than a fixed sentence
      pollTimeout: timedOut ? finalExecution.pollTimeout : undefined,
    });
    const relayActionTrace = verdict.actionTrace;

    // Evaluation: the backend derives it from the SAME verdict as the headline
    // (sentinal-sk5sl.1), so its passed/outcome/reason are that verdict a second
    // time — and passed is just outcome === 'pass'. Relay only what the verdict
    // does not already carry (e.g. verifications); omit it when that is nothing.
    let evaluation: Record<string, any> | undefined;
    if (finalExecution.evaluation && typeof finalExecution.evaluation === 'object') {
      const { passed: _p, outcome: _o, reason: _r, ...rest } = finalExecution.evaluation as Record<string, any>;
      if (Object.keys(rest).length > 0) evaluation = rest;
    }

    // --- Post-hoc tunnel reclassification (bugs z15n, 4bui) ---
    // The pre-flight probe above proves the tunnel was alive when we handed it to
    // the remote browser — it can still die mid-run. When it does, the browser
    // lands on the tunnel server's DEBUGG_TUNNEL_* interstitial and the backend, which only sees
    // "the page didn't contain what I was asked about", returns a normal 'fail'
    // whose reason blames the USER'S page for OUR dead tunnel (execution
    // a8f07747: 217s, 7 steps, failureCategory 'fail').
    //
    // THE MARKER IS REQUIRED (bug 4bui). Reclassifying overrides the backend's
    // verdict, so it demands positive evidence of the claim we are actually
    // making: that the remote browser hit OUR error page DURING THE RUN. Only
    // the DEBUGG_TUNNEL_* marker recorded BY the run is evidence of that.
    //
    // The re-probe is NOT such evidence and can no longer trigger this on its
    // own. It answers a different question — "is the tunnel healthy NOW?" —
    // and we were using its answer to assert something about the run window.
    // That laundered a genuine UI failure into an infrastructure excuse:
    // execution 2aa14b0b completed 2.78s BEFORE its upstream was killed (tunnel
    // alive for 100% of the run, no marker, an honest evidence-strictness
    // verdict) and we still stamped it TunnelOfflineDuringRun. Worse, the probe
    // independently returned a FALSE NETWORK_ERROR on healthy servers ~1 in 5
    // runs (bug k6yq), so the false positive was reachable with nothing
    // whatsoever wrong. (k6yq is now fixed: the cause was not the suspected DNS
    // race but a connection-level flake against a freshly created
    // tunnel, which probeTunnelHealth now retries. The marker requirement
    // stands on its own regardless — the probe never decides this.)
    //
    // Requiring the marker loses no coverage: a real mid-run death fires BOTH
    // arms (live-confirmed — re-probe NETWORK_ERROR *and* an endpoint-gone marker),
    // so the marker alone still catches it. The probe is kept purely as
    // CORROBORATION in `detail` — it tells the caller whether the tunnel is
    // still down now or has since recovered. Per epic 56kd ("relay honestly,
    // invent nothing"), asserting an infrastructure fault we did not observe
    // during the run is the relay inventing a cause.
    let tunnelFault: { probe?: TunnelHealthProbeResult; tunnelErrorCode?: string } | undefined;
    if (verdict.outcome === 'fail' && ctx.isLocalhost && ctx.tunnelId && ctx.targetUrl) {
      const marker = findTunnelErrorMarker([
        verdict.reason,
        finalExecution.state?.error,
        finalExecution.errorMessage,
        relayActionTrace,
      ]);
      // probeTunnelHealth never throws by contract; guard anyway — a probe we
      // couldn't run is NOT evidence of a fault. Corroboration only: its result
      // never decides whether we reclassify, only what we report alongside it.
      const probe = await probeTunnelHealth(ctx.targetUrl).catch(() => undefined);
      if (marker) {
        tunnelFault = { probe, tunnelErrorCode: marker };
        logger.warn(
          `Reclassifying backend 'fail' as an infrastructure fault for ${executionUuid}: ` +
          `the run recorded ${marker} (re-probe now: ` +
          `${probe ? (probe.healthy ? 'healthy — tunnel has since recovered' : probe.code) : 'unavailable'})`,
        );
      } else if (probe && !probe.healthy) {
        // Deliberately NOT reclassifying. The tunnel looks unhealthy now, but
        // the run recorded no tunnel interstitial, so we have no evidence the
        // browser ever saw one — the tunnel most likely died after the run (or
        // the probe flaked). Relay the backend's verdict and log the tension.
        logger.info(
          `Post-run tunnel re-probe for ${executionUuid} was unhealthy (${probe.code}) but the run ` +
          'recorded no DEBUGG_TUNNEL_* marker, so the browser reached the app during the run. Relaying ' +
          "the backend's verdict verbatim rather than blaming the tunnel.",
        );
      }
    }

    const responsePayload: Record<string, any> = {
      outcome: verdict.outcome,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      status: finalExecution.status,
      executionId: executionUuid,
      targetUrl: originalUrl,
      durationMs: finalExecution.durationMs ?? duration,
    };
    if (verdict.budget) responsePayload.budget = verdict.budget;

    // For "navigate and describe what you see", the answer IS the deliverable —
    // and it reached callers only incidentally, buried in actionTrace[0].intent,
    // which the verify-gate rewrites when it disagrees with the page. Surface it.
    if (verdict.report) responsePayload.report = verdict.report;
    if (verdict.logins) responsePayload.logins = verdict.logins;
    if (verdict.loginError) responsePayload.loginError = verdict.loginError;

    // Bead b5x6: the caller named an account and the run SUBMITTED an
    // environment default for a different one. Stated as the two facts — what
    // was asked for, what was used — and nothing about what to conclude.
    // Only a SUBMITTED env-default login under a DIFFERENT account counts: a
    // refused/skipped login typed nothing, and the env's stored credential may
    // be the very account that was named.
    const requestedIdentity = input.username
      ?? input.auth?.username
      ?? input.loginCredentials?.[0]?.username;
    const substituted = credentialSubstitutions(verdict.logins, [
      input.username,
      input.auth?.username,
      ...(input.loginCredentials ?? []).map(c => c.username),
    ]);
    if (requestedIdentity && substituted.length > 0) {
      responsePayload.credentialWarning = {
        requested: requestedIdentity,
        used: [...new Set(substituted.map(l => l.username as string))],
      };
      logger.warn(
        `check_app_in_browser: requested identity '${requestedIdentity}' but the run used ` +
        `environment-default credential(s): ${responsePayload.credentialWarning.used.join(', ')}`,
      );
    }

    // Bug z15n: the run itself recorded our tunnel's DEBUGG_TUNNEL_* interstitial,
    // so its 'fail' describes our error page, not the user's app. That is an
    // MCP-observed fact, so the MCP may state it: outcome 'error', a reason
    // built from the marker and the probe result, the backend's own verdict kept
    // verbatim under `backendVerdict`. No commentary on top.
    if (tunnelFault) {
      const { probe, tunnelErrorCode } = tunnelFault;
      responsePayload.backendVerdict = { outcome: verdict.outcome, reason: verdict.reason };
      responsePayload.outcome = 'error';
      responsePayload.error = 'TunnelOfflineDuringRun';
      const probeFact = probe
        ? probe.healthy
          ? 'post-run tunnel probe: reachable'
          : `post-run tunnel probe: ${probe.code}${probe.status ? ` (HTTP ${probe.status})` : ''}`
        : 'post-run tunnel probe: not run';
      responsePayload.reason = `The run recorded the tunnel error page ${tunnelErrorCode}; ${probeFact}.`;
      responsePayload.detail = {
        tunnelErrorCode,
        probeCode: probe?.code,
        probeStatus: probe?.status,
        probeHealthy: probe?.healthy,
        probeElapsedMs: probe?.elapsedMs,
      };
    }

    if (Array.isArray(relayActionTrace) && relayActionTrace.length > 0) responsePayload.actionTrace = relayActionTrace;
    if (evaluation) responsePayload.evaluation = evaluation;
    if (finalExecution.state?.error) responsePayload.agentError = finalExecution.state.error;
    if (finalExecution.errorMessage) responsePayload.errorMessage = finalExecution.errorMessage;
    if (finalExecution.errorInfo) responsePayload.errorInfo = finalExecution.errorInfo;
    if (executeResponse.resolvedEnvironmentId) responsePayload.resolvedEnvironmentId = executeResponse.resolvedEnvironmentId;
    if (executeResponse.resolvedCredentialId) responsePayload.resolvedCredentialId = executeResponse.resolvedCredentialId;
    // browser_session block: presigned S3 URLs for HAR + console log + recording,
    // passed through verbatim.
    if (finalExecution.browserSession) {
      responsePayload.browserSession = finalExecution.browserSession;
    }

    logger.toolComplete('check_app_in_browser', duration);

    // NOTE (bead 0bq): the final "Complete:" progress is emitted INSIDE
    // pollExecution's onUpdate when terminal status is detected — see the
    // TERMINAL_STATUSES block above. Emitting it here (post-resolve) creates
    // a race where the progress can arrive AFTER the response on the wire,
    // making the client reject it as an unknown progressToken and close the
    // transport, breaking ALL subsequent tool calls.

    // Sanitize the whole payload so no tunnel URL leaks anywhere — including
    // agent-authored strings in actionTrace[*].intent, evaluation.reason, etc.
    const sanitizedPayload = sanitizeResponseUrls(responsePayload, ctx);
    const content: ToolResponse['content'] = [
      { type: 'text', text: JSON.stringify(sanitizedPayload, null, 2) },
    ];

    // Screenshot: check for already-base64 field first (subworkflow.run), then URL-based fields
    const SCREENSHOT_URL_KEYS = ['finalScreenshot', 'screenshot', 'screenshotUrl', 'screenshotUri'];
    const GIF_KEYS = ['runGif', 'gifUrl', 'gif', 'videoUrl', 'recordingUrl'];

    let screenshotEmbedded = false;
    let gifUrl: string | null = null;
    let screenshotUrl: string | null = null;

    // Contract evidence.screenshot (bead 56kd.2/.3) is the preferred source and
    // is present on EVERY terminal state — including fail and timeout — so we
    // always have the last screenshot on non-success. Base64 embeds inline; an
    // http(s) URL is fetched below via the same path as legacy node URLs.
    const evidenceScreenshot = verdict.screenshot;
    if (typeof evidenceScreenshot === 'string' && evidenceScreenshot) {
      if (/^https?:\/\//i.test(evidenceScreenshot)) {
        screenshotUrl = evidenceScreenshot;
      } else {
        logger.info('Embedding inline base64 screenshot from backend evidence');
        content.push(imageContentBlock(evidenceScreenshot, 'image/png'));
        screenshotEmbedded = true;
      }
    }

    // subworkflow.run carries screenshotB64 directly — no fetch needed
    const screenshotB64 = subworkflowNode?.outputData?.screenshotB64;
    if (!screenshotEmbedded && !screenshotUrl && typeof screenshotB64 === 'string' && screenshotB64) {
      logger.info('Embedding inline base64 screenshot from subworkflow.run');
      content.push(imageContentBlock(screenshotB64, 'image/png'));
      screenshotEmbedded = true;
    }

    for (const node of nodes) {
      const data = node.outputData ?? {};
      if (!screenshotEmbedded && !screenshotUrl) {
        for (const key of SCREENSHOT_URL_KEYS) {
          if (typeof data[key] === 'string' && data[key]) {
            screenshotUrl = data[key] as string;
            break;
          }
        }
      }
      if (!gifUrl) {
        for (const key of GIF_KEYS) {
          if (typeof data[key] === 'string' && data[key]) {
            gifUrl = data[key] as string;
            break;
          }
        }
      }
      if ((screenshotEmbedded || screenshotUrl) && gifUrl) break;
    }

    if (!screenshotEmbedded && screenshotUrl) {
      logger.info(`Embedding screenshot: ${screenshotUrl}`);
      const img = await fetchImageAsBase64(screenshotUrl).catch(() => null);
      if (img) content.push(imageContentBlock(img.data, img.mimeType));
    }
    // Artifact links (bead 8qndk): run recording (legacy GIF field) + the
    // browserSession presigned URLs (HAR / console log / recording). Returned as
    // resource_links, not base64-inlined. Screenshots stay inline above so
    // vision-capable clients still SEE them.
    const artifactLinks = [
      ...(gifUrl
        ? [resourceLinkBlock(gifUrl, 'run-recording.gif', {
            mimeType: 'image/gif',
            title: 'Run recording',
          })]
        : []),
      ...artifactResourceLinks((sanitizedPayload as Record<string, unknown>).browserSession),
    ];
    const seenArtifactUris = new Set<string>();
    for (const link of artifactLinks) {
      if (link.uri && !seenArtifactUris.has(link.uri)) {
        seenArtifactUris.add(link.uri);
        content.push(link);
      }
    }

    // Bug z15n: an infrastructure fault is an error, not a check result — same
    // posture as the LocalServerUnreachable / TunnelTrafficBlocked pre-checks.
    // The evidence (screenshot, trace, artifacts) still rides along in `content`.
    return tunnelFault ? { content, isError: true } : { content };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('check_app_in_browser', error as Error, duration);

    if (error instanceof Error && (error.message.includes('not found') || error.message.includes('401'))) {
      invalidateTemplateCache();
      invalidateProjectCache();
    }

    throw handleExternalServiceError(error, 'DebuggAI', 'test execution');
  } finally {
    if (requestSignal) requestSignal.removeEventListener('abort', onAbort);
    // §2.4: release this call's claim on the shared port route (no-op if we
    // never acquired one — public URL, dev mode, or an early-return before
    // acquisition). Covers every early-return path above for free.
    releasePortRoute(ctx);
    // Tunnel is intentionally NOT torn down here — tunnelManager reuses it on
    // subsequent calls to the same port and auto-shutoffs after 55 min idle.
    // Process-exit cleanup happens via stopAllTunnels() in the SIGINT/SIGTERM
    // handlers in index.ts.
    if (!ctx.tunnelId && provision) {
      // Provisioned a tunnel but creation failed — revoke it, through whichever
      // endpoint its transport uses.
      const orphan = provision;
      client.tunnels!.revoke(orphan).catch(err =>
        logger.warn(`Failed to revoke unused tunnel ${orphan.tunnelId}: ${err}`)
      );
    }
  }
}
