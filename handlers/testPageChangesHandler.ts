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
} from '../types/index.js';
import { config } from '../config/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { fetchImageAsBase64, imageContentBlock, resourceLinkBlock, artifactResourceLinks } from '../utils/imageUtils.js';
import { DebuggAIServerClient } from '../services/index.js';
import { getEvalTemplateSlug } from '../services/workflows.js';
import { adaptVerdict } from '../services/verdictAdapter.js';
import { TunnelProvisionError } from '../services/tunnels.js';
import {
  resolveTargetUrl,
  buildContext,
  findExistingTunnel,
  ensureTunnel,
  sanitizeResponseUrls,
  touchTunnelById,
} from '../utils/tunnelContext.js';
import { detectRepoName } from '../utils/gitContext.js';
import { tunnelManager } from '../services/ngrok/tunnelManager.js';
import { probeLocalPort, probeTunnelHealth, extractNgrokErrorCode } from '../utils/localReachability.js';
import type { TunnelHealthProbeResult } from '../utils/localReachability.js';
import { extractLocalhostPort } from '../utils/urlParser.js';
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

// Bug z15n: scan run evidence for ngrok's interstitial marker. The marker is a
// stable, recognizable string the REMOTE BROWSER saw — positive evidence that it
// hit our tunnel's error page rather than the user's app. Non-string parts are
// serialized (the action trace is the usual carrier); a part we can't serialize
// is simply skipped — it is not evidence either way.
function findNgrokErrorMarker(parts: unknown[]): string | undefined {
  for (const part of parts) {
    if (part === undefined || part === null || part === '') continue;
    let text: string;
    try {
      text = typeof part === 'string' ? part : JSON.stringify(part) ?? '';
    } catch {
      continue;
    }
    const code = extractNgrokErrorCode(text);
    if (code) return code;
  }
  return undefined;
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
  let keyId: string | undefined;

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
      // provision + ngrok session. If the user's dev server isn't listening,
      // fail in ~1.5s with a structured error instead of burning 5 minutes
      // on a browser agent trying to reach a dead tunnel.
      const localPort = extractLocalhostPort(ctx.originalUrl);
      if (typeof localPort === 'number') {
        const probe = await probeLocalPort(localPort);
        if (!probe.reachable) {
          const payload = {
            error: 'LocalServerUnreachable',
            message: `No server listening on 127.0.0.1:${localPort}. Start your dev server on that port before running check_app_in_browser. Probe result: ${probe.code} (${probe.detail ?? 'no detail'}).`,
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
            throw new Error(
              `Failed to provision tunnel for ${ctx.originalUrl}. ` +
              `The remote browser needs a secure tunnel to reach your local dev server. ` +
              `Make sure your dev server is running on the specified port and try again. ` +
              `(Detail: ${msg})${diag}`
            );
          }
          keyId = tunnel.keyId;
          try {
            ctx = await ensureTunnel(
              ctx,
              tunnel.tunnelKey,
              tunnel.tunnelId,
              tunnel.keyId,
              () => client.revokeNgrokKey(tunnel.keyId),
            );
          } catch (tunnelError) {
            const msg = tunnelError instanceof Error ? tunnelError.message : String(tunnelError);
            throw new Error(
              `Tunnel creation failed for ${ctx.originalUrl}. ` +
              `Could not establish a secure connection between the remote browser and your local port. ` +
              `Verify your dev server is running and the port is accessible. ` +
              `(Detail: ${msg})`
            );
          }
          logger.info(`Tunnel ready: ${ctx.targetUrl} (id: ${ctx.tunnelId})`);
        }

        // Bead 1om: verify traffic actually flows through the tunnel. The
        // tunnel can be established (ngrok.connect returns OK) yet refuse
        // to forward traffic — e.g., IPv4/IPv6 bind mismatch, or the dev
        // server died between the pre-flight probe and here. Catch it now,
        // in ~1s, not via a 5-minute browser-agent false-pass.
        if (ctx.targetUrl) {
          const health = await probeTunnelHealth(ctx.targetUrl);
          if (!health.healthy) {
            const payload = {
              error: 'TunnelTrafficBlocked',
              message: `Tunnel was established but traffic isn't reaching the dev server. ${health.detail ?? ''} Common causes: dev server binds to 0.0.0.0 or ::1 but not 127.0.0.1; dev server crashed; firewall.`,
              detail: {
                code: health.code,
                status: health.status,
                ngrokErrorCode: health.ngrokErrorCode,
                elapsedMs: health.elapsedMs,
              },
            };
            logger.warn(`Tunnel health probe failed for ${ctx.targetUrl}: ${health.code} ${health.ngrokErrorCode ?? ''} in ${health.elapsedMs}ms`);
            // Tear down the broken tunnel so a subsequent call doesn't reuse it.
            // stopTunnel handles both owned (ngrok disconnect + key revoke) and
            // borrowed (just drops local ref) cases.
            if (ctx.tunnelId) {
              tunnelManager.stopTunnel(ctx.tunnelId).catch((err) =>
                logger.warn(`Failed to stop broken tunnel ${ctx.tunnelId}: ${err}`),
              );
            }
            // keyId is consumed by stopTunnel's revoke path; clear so the
            // outer finally block doesn't double-revoke.
            keyId = undefined;
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
      throw new Error(
        'App Evaluation Workflow Template not found. ' +
        'Ensure the template is seeded in the backend (GET /api/v1/workflows/?is_template=true).'
      );
    }
    // Fail fast + actionable when project_id can't be resolved (pinned backend
    // semantics: project_id is required). Surfacing "link this repo to a
    // project" now — before executeWorkflow — beats letting a backend workflow
    // node fail mid-run several minutes into the evaluation.
    if (!projectUuid) {
      const detail = repoName
        ? `Repo "${repoName}" isn't linked to a DebuggAI project.`
        : 'No git repository was detected to resolve a project from.';
      const payload = {
        error: 'ProjectRequired',
        message:
          `project_id is required but could not be resolved. ${detail} ` +
          'Link this repo to a project at https://debugg.ai (Projects → connect your repository), then retry. ' +
          'To evaluate a different repo than the current one, pass repoName.',
      };
      logger.warn(`check_app_in_browser: ${payload.message}`);
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
    }

    // --- Build context data (camelCase here — axiosTransport auto-converts to snake_case) ---
    const contextData: Record<string, any> = {
      targetUrl: ctx.targetUrl ?? originalUrl,
      question: input.description,
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
      if (input.auth.entryUrl) auth.entryUrl = input.auth.entryUrl;
      if (input.auth.deepUrl) auth.deepUrl = input.auth.deepUrl;
      if (Object.keys(auth).length > 0) contextData.auth = auth;
    }

    // --- Build env (credentials/environment) ---
    const env: Record<string, any> = {};
    if (input.environmentId) env.environmentId = input.environmentId;
    if (input.credentialId) env.credentialId = input.credentialId;
    if (input.credentialRole) env.credentialRole = input.credentialRole;
    if (input.username) env.username = input.username;
    if (input.password) env.password = input.password;

    // --- Execute ---
    logger.info('Sending contextData', { contextData, env: Object.keys(env).length > 0 ? env : undefined });
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
        const terminalOutcome = exec.state?.outcome ?? exec.status;
        await progressCallback({
          progress: TOTAL_STEPS,
          total: TOTAL_STEPS,
          message: `Complete: ${terminalOutcome}`,
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

    // subworkflow.run is the current graph shape — carries outcome, actionHistory, screenshot
    const subworkflowNode = nodes.find(n => n.nodeType === 'subworkflow.run');
    // surfer.execute_task and brain.step/brain.evaluate are older graph shapes
    const surferNode = nodes.find(n => n.nodeType === 'surfer.execute_task');

    // Action trace: brain.step nodes (old) → subworkflow.run actionHistory (new)
    const brainSteps = nodes
      .filter(n => n.nodeType === 'brain.step' && n.outputData)
      .sort((a, b) => a.executionOrder - b.executionOrder);

    const actionTrace = brainSteps.map((n, i) => {
      const d = n.outputData!.decision ?? n.outputData!;
      return {
        step: i + 1,
        action: d.actionType ?? d.action_type,
        intent: d.intent,
        target: d.target,
        value: d.value ?? undefined,
        success: n.outputData!.success ?? n.status === 'success',
        durationMs: n.executionTimeMs,
      };
    });

    const subworkflowHistory = subworkflowNode?.outputData?.actionHistory;
    if (actionTrace.length === 0 && Array.isArray(subworkflowHistory) && subworkflowHistory.length > 0) {
      subworkflowHistory.forEach((step: any, i: number) => {
        actionTrace.push({
          step: i + 1,
          action: step.actionType ?? step.action_type ?? step.action,
          intent: step.intent,
          target: step.target,
          value: step.value ?? undefined,
          success: step.success ?? true,
          durationMs: step.durationMs ?? step.duration_ms ?? undefined,
        });
      });
    }

    // Evaluation: brain.evaluate (old) → subworkflow.run outcome/success (new)
    const evalNode = nodes.find(n => n.nodeType === 'brain.evaluate');
    let evaluation: Record<string, any> | undefined;
    if (evalNode?.outputData) {
      evaluation = {
        passed: evalNode.outputData.passed,
        outcome: evalNode.outputData.outcome,
        reason: evalNode.outputData.reason,
        verifications: evalNode.outputData.verifications,
      };
    } else if (subworkflowNode?.outputData) {
      const sw = subworkflowNode.outputData;
      evaluation = {
        passed: sw.success,
        outcome: sw.outcome,
        reason: sw.error || undefined,
      };
    }

    // --- Relay the backend's explicit verdict (bead 56kd.2) ---
    // ONE adapter owns the backend-field → MCP mapping (services/verdictAdapter).
    // We consume the verdict/budget/evidence VERBATIM — no fabricated outcome,
    // no success default-false, no synthesized 'assertion-mismatch'. A
    // missing/unknown verdict surfaces as 'inconclusive', never as a failure.
    // On a poll-deadline timeout (bead 56kd.3) pollExecution returns the last
    // observed execution flagged `timedOut`; force outcome 'timeout' since there
    // is no terminal backend verdict, and shape its partial evidence below.
    const timedOut = finalExecution.timedOut === true;
    const verdict = adaptVerdict(finalExecution, {
      fallbackBudget: MAX_EXEC_STEPS,
      outcomeOverride: timedOut ? 'timeout' : undefined,
    });

    // Evidence: prefer the backend's contract evidence.actionTrace; fall back to
    // the legacy node-extracted trace while the backend contract deploys.
    const relayActionTrace = verdict.actionTrace ?? actionTrace;

    // --- Post-hoc tunnel reclassification (bugs z15n, 4bui) ---
    // The pre-flight probe above proves the tunnel was alive when we handed it to
    // the remote browser — it can still die mid-run. When it does, the browser
    // lands on ngrok's ERR_NGROK_* interstitial and the backend, which only sees
    // "the page didn't contain what I was asked about", returns a normal 'fail'
    // whose reason blames the USER'S page for OUR dead tunnel (execution
    // a8f07747: 217s, 7 steps, failureCategory 'fail').
    //
    // THE MARKER IS REQUIRED (bug 4bui). Reclassifying overrides the backend's
    // verdict, so it demands positive evidence of the claim we are actually
    // making: that the remote browser hit OUR error page DURING THE RUN. Only
    // the ERR_NGROK_* marker recorded BY the run is evidence of that.
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
    // race but an HTTP/2 GOAWAY from the ngrok edge on a freshly created
    // tunnel, which probeTunnelHealth now retries. The marker requirement
    // stands on its own regardless — the probe never decides this.)
    //
    // Requiring the marker loses no coverage: a real mid-run death fires BOTH
    // arms (live-confirmed — re-probe NETWORK_ERROR *and* marker ERR_NGROK_3200),
    // so the marker alone still catches it. The probe is kept purely as
    // CORROBORATION in `detail` — it tells the caller whether the tunnel is
    // still down now or has since recovered. Per epic 56kd ("relay honestly,
    // invent nothing"), asserting an infrastructure fault we did not observe
    // during the run is the relay inventing a cause.
    let tunnelFault: { probe?: TunnelHealthProbeResult; ngrokErrorCode?: string } | undefined;
    if (verdict.outcome === 'fail' && ctx.isLocalhost && ctx.tunnelId && ctx.targetUrl) {
      const marker = findNgrokErrorMarker([
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
        tunnelFault = { probe, ngrokErrorCode: marker };
        logger.warn(
          `Reclassifying backend 'fail' as an infrastructure fault for ${executionUuid}: ` +
          `the run recorded ${marker} (re-probe now: ` +
          `${probe ? (probe.healthy ? 'healthy — tunnel has since recovered' : probe.code) : 'unavailable'})`,
        );
      } else if (probe && !probe.healthy) {
        // Deliberately NOT reclassifying. The tunnel looks unhealthy now, but
        // the run recorded no ngrok interstitial, so we have no evidence the
        // browser ever saw one — the tunnel most likely died after the run (or
        // the probe flaked). Relay the backend's verdict and log the tension.
        logger.info(
          `Post-run tunnel re-probe for ${executionUuid} was unhealthy (${probe.code}) but the run ` +
          'recorded no ERR_NGROK_* marker, so the browser reached the app during the run. Relaying ' +
          "the backend's verdict verbatim rather than blaming the tunnel.",
        );
      }
    }

    const responsePayload: Record<string, any> = {
      outcome: verdict.outcome,
      success: verdict.success,
      status: finalExecution.status,
      stepsTaken: verdict.stepsTaken,
      stepsBudget: verdict.stepsBudget,          // from the response (bead 56kd.2)
      stepsRemaining: verdict.stepsRemaining,
      targetUrl: originalUrl,
      executionId: executionUuid,
      durationMs: finalExecution.durationMs ?? duration,
    };

    // failureCategory = the outcome verbatim (fail | inconclusive | error |
    // timeout); OMITTED on success. No inference, no 'assertion-mismatch'.
    if (verdict.failureCategory) responsePayload.failureCategory = verdict.failureCategory;
    if (verdict.reason) responsePayload.reason = verdict.reason;

    // Bug z15n: OUR tunnel died mid-run, so this 'fail' describes our error page,
    // not the user's app. Relay it as a distinct, retryable infrastructure class
    // so an automated caller doesn't record a UI regression that never happened.
    // The backend's original verdict is preserved verbatim, never swallowed.
    //
    // Bug 4bui: the stated cause leads with the MARKER, because the marker is the
    // evidence that justified getting here — the run itself recorded ngrok's
    // interstitial. The probe only corroborates (and may legitimately say the
    // tunnel has recovered by now), so it rides in `detail`, never as the cause.
    if (tunnelFault) {
      const { probe, ngrokErrorCode } = tunnelFault;
      responsePayload.backendVerdict = { outcome: verdict.outcome, reason: verdict.reason };
      responsePayload.outcome = 'error';
      responsePayload.success = false;
      responsePayload.failureCategory = 'infrastructure';
      responsePayload.error = 'TunnelOfflineDuringRun';
      responsePayload.message =
        'During this run the remote browser landed on our tunnel\'s ngrok error page instead of your ' +
        'app, so the check evaluated our error page rather than your UI. This is an infrastructure ' +
        'fault on our side, not a failed check — retry it. The backend\'s original verdict is ' +
        'preserved under `backendVerdict`.';
      responsePayload.reason =
        `The run recorded ngrok's ${ngrokErrorCode} interstitial, so the remote browser reached ` +
        'our tunnel error page instead of your app.' +
        (probe
          ? probe.healthy
            ? ' (Our re-probe after the run found the tunnel reachable again, so it has since recovered.)'
            : ` (Our re-probe after the run also failed: ${probe.code}` +
              `${probe.status ? ` (HTTP ${probe.status})` : ''}.)`
          : '');
      responsePayload.detail = {
        ngrokErrorCode,
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
    if (finalExecution.errorInfo?.failedNodeId) responsePayload.failedNode = finalExecution.errorInfo.failedNodeId;
    if (executeResponse.resolvedEnvironmentId) responsePayload.resolvedEnvironmentId = executeResponse.resolvedEnvironmentId;
    if (executeResponse.resolvedCredentialId) responsePayload.resolvedCredentialId = executeResponse.resolvedCredentialId;
    if (surferNode?.outputData) {
      responsePayload.surferOutput = sanitizeResponseUrls(surferNode.outputData, ctx);
    }
    // Backend release 2026-04-25: browser_session block on execution detail
    // carries presigned S3 URLs for HAR + console log + recording. Pass through
    // verbatim — sanitizeResponseUrls below only strips ngrok hosts so S3 URLs
    // are preserved. Resolves client-feedback items #1 (network) + #7 (console).
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
            description: 'Animated recording of the run (presigned URL — open or fetch on demand).',
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
    // Tunnel is intentionally NOT torn down here — tunnelManager reuses it on
    // subsequent calls to the same port and auto-shutoffs after 55 min idle.
    // Process-exit cleanup happens via stopAllTunnels() in the SIGINT/SIGTERM
    // handlers in index.ts.
    if (!ctx.tunnelId && keyId) {
      // Provisioned a key but tunnel creation failed — revoke the orphaned key.
      client.revokeNgrokKey(keyId).catch(err =>
        logger.warn(`Failed to revoke unused ngrok key ${keyId}: ${err}`)
      );
    }
  }
}
