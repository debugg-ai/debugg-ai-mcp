/**
 * probePageHandler — lightweight no-LLM batch page probe.
 *
 * Mirrors triggerCrawlHandler's 4-step pattern (find template → execute →
 * poll → format response) but: (a) takes a list of targets and produces a
 * list of results, (b) does no agent steps (zero LLM in critical path),
 * (c) MCP-side aggregates per-target HAR slices into NetworkSummary[].
 *
 * The backend "Page Probe" workflow template runs:
 *   browser.setup → loop[targets](browser.navigate → browser.capture) → done
 *
 * Each browser.capture node emits per-iteration outputData with consoleSlice
 * + harSlice windowed to that URL's load span — that's what makes per-URL
 * networkSummary attribution accurate.
 */

import {
  ProbePageInput,
  ProbePageResult,
  ToolResponse,
  ToolContext,
  ProgressCallback,
} from '../types/index.js';
import { config } from '../config/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { TunnelProvisionError } from '../services/tunnels.js';
import { disposeUnhealthyTunnel } from '../utils/tunnelDisposition.js';
import { probeLocalPort, probeTunnelHealth } from '../utils/localReachability.js';
import { extractLocalhostPort } from '../utils/urlParser.js';
import {
  buildContext,
  findExistingTunnel,
  ensureTunnel,
  acquirePortRoute,
  releasePortRoute,
  sanitizeResponseUrls,
  touchTunnelById,
  TunnelContext,
} from '../utils/tunnelContext.js';
import { randomUUID } from 'node:crypto';
import { getCachedTemplateUuid, invalidateTemplateCache } from '../utils/handlerCaches.js';
import { getPageProbeTemplateSlug } from '../services/workflows.js';
import { reaggregateByOriginPath, mapConsoleSlice } from '../utils/harSummarizer.js';
import { fetchImageAsBase64, imageContentBlock } from '../utils/imageUtils.js';

const logger = new Logger({ module: 'probePageHandler' });

/**
 * A batch of `input.targets` (by index) that share one Caddy route — either
 * one localhost {port, isHttpsLocal} pair, or the single "public" bucket for
 * every non-localhost target (which needs no route at all). §4's multi-port
 * batch decision: single-group batches dispatch exactly as before (one
 * repoint, one backend execution); multi-group batches decompose into one
 * sequential acquirePortRoute → executeWorkflow(subset) → poll →
 * releasePortRoute cycle per group, merging results back into the caller's
 * original target order.
 */
interface TargetGroup {
  key: string;
  indices: number[];
  /** Whether this group needs a Caddy route at all (false for the 'public' bucket). */
  needsRoute: boolean;
}

function groupTargetsByRoute(targetContexts: TunnelContext[]): TargetGroup[] {
  const groups: TargetGroup[] = [];
  const byKey = new Map<string, TargetGroup>();
  for (let i = 0; i < targetContexts.length; i++) {
    const tc = targetContexts[i];
    let key: string;
    let needsRoute = false;
    if (tc.isLocalhost && tc.tunnelId) {
      const port = extractLocalhostPort(tc.originalUrl);
      const isHttpsLocal = tc.originalUrl.startsWith('https:');
      key = `local:${port}:${isHttpsLocal}`;
      needsRoute = true;
    } else {
      // Public URLs (and dev-mode localhost, which never gets a tunnelId)
      // share ONE group — no route to serialize, no reason to split them.
      key = 'public';
    }
    let group = byKey.get(key);
    if (!group) {
      group = { key, indices: [], needsRoute };
      byKey.set(key, group);
      groups.push(group);
    }
    group.indices.push(i);
  }
  return groups;
}

export async function probePageHandler(
  input: ProbePageInput,
  context: ToolContext,
  rawProgressCallback?: ProgressCallback,
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('probe_page', input);

  // Bead 0bq: progress circuit-breaker — see testPageChangesHandler for rationale.
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

  // Bead 56kd.7: cancellation is driven by the MCP request/transport lifecycle
  // (context.signal), NOT process.stdin. The SDK aborts context.signal when the
  // client cancels the call OR the transport closes — e.g. an HTTP client drops
  // the connection. Under the stateless HTTP transport that is the ONLY signal
  // we get: stdin is not the transport, so the old stdin 'close' listener never
  // fired and a dropped client kept polling for up to ~10 min. Wiring to
  // context.signal cancels the poll immediately (parity with 56kd.5).
  const abortController = new AbortController();
  const onAbort = () => {
    abortController.abort();
    progressDisabled = true; // client is gone — stop emitting
  };
  const requestSignal = context.signal;
  if (requestSignal) {
    if (requestSignal.aborted) onAbort();
    else requestSignal.addEventListener('abort', onAbort, { once: true });
  }

  // Base id for the shared port-route lock's holder bookkeeping (§2.4) — one
  // per target GROUP, suffixed below, since a multi-port batch acquires the
  // route once per group, sequentially.
  const callId = randomUUID();

  // Per-target tunnel contexts. Index aligns with input.targets[].
  const targetContexts: TunnelContext[] = [];
  // Tunnel keys we provisioned this call (for cleanup if creation fails after key acquired).
  const acquiredKeyIds: string[] = [];

  // Progress budget: 1 pre-flight + 1 template + 1 execute + N per-target captures + 1 done
  const TOTAL_STEPS = 3 + input.targets.length + 1;
  let progressStep = 0;

  try {
    if (progressCallback) {
      await progressCallback({ progress: ++progressStep, total: TOTAL_STEPS, message: `Pre-flight + tunnel setup (${input.targets.length} target${input.targets.length === 1 ? '' : 's'})...` });
    }

    // ── Per-target pre-flight + tunnel resolution ──────────────────────────
    for (const target of input.targets) {
      const ctx = buildContext(target.url);

      if (ctx.isLocalhost) {
        // Pre-flight TCP probe: fail fast if dev server isn't listening.
        const port = extractLocalhostPort(ctx.originalUrl);
        if (typeof port === 'number') {
          const probe = await probeLocalPort(port);
          if (!probe.reachable) {
            const payload = {
              error: 'LocalServerUnreachable',
              message: `No server listening on 127.0.0.1:${port}. Start your dev server on that port before running probe_page. Probe result: ${probe.code} (${probe.detail ?? 'no detail'}).`,
              detail: {
                port,
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
          logger.info(`probe_page: dev mode — using localhost URL directly: ${ctx.originalUrl}`);
          targetContexts.push(ctx);
        } else {
          // Reuse existing tunnel for this port if any; otherwise provision.
          const reused = findExistingTunnel(ctx);
          if (reused) {
            targetContexts.push(reused);
          } else {
            let tunnel;
            try {
              tunnel = await client.tunnels!.provisionWithRetry();
            } catch (provisionError) {
              const msg = provisionError instanceof Error ? provisionError.message : String(provisionError);
              const diag = provisionError instanceof TunnelProvisionError ? ` ${provisionError.diagnosticSuffix()}` : '';
              throw new Error(
                `Failed to provision tunnel for ${ctx.originalUrl}. ` +
                `(Detail: ${msg})${diag}`
              );
            }
            acquiredKeyIds.push(tunnel.keyId);
            let tunneled: TunnelContext;
            try {
              tunneled = await ensureTunnel(
                ctx,
                tunnel.tunnelKey,
                tunnel.tunnelId,
                tunnel.keyId,
                () => client.revokeNgrokKey(tunnel.keyId),
              );
            } catch (tunnelError) {
              const msg = tunnelError instanceof Error ? tunnelError.message : String(tunnelError);
              throw new Error(
                `Tunnel creation failed for ${ctx.originalUrl}. (Detail: ${msg})`
              );
            }

            // NOTE: the tunnel health probe used to run right here, immediately
            // after ensureTunnel. Under the session-tunnel + Caddy model that is
            // WRONG — ensureTunnel only confirms the tunnel reaches Caddy, not
            // that Caddy is pointed at THIS target's port yet (that's
            // acquirePortRoute's job, per-group, below). Probing here would
            // probe whatever port Caddy happened to be pointed at a moment ago
            // (often the placeholder, on a session's first call), not this
            // target's port — see utils/tunnelContext.ts's acquirePortRoute
            // doc comment. Moved to right after acquirePortRoute succeeds.

            targetContexts.push(tunneled);
          }
        }
      } else {
        // Public URL — no tunnel needed.
        targetContexts.push(ctx);
      }
    }

    // ── Locate workflow template ───────────────────────────────────────────
    if (progressCallback) {
      await progressCallback({ progress: ++progressStep, total: TOTAL_STEPS, message: 'Locating page-probe workflow template...' });
    }

    // Pin dispatch to the stable slug (bead 56kd.8) — no fuzzy name resolution.
    // Cache key = the slug so the key and the lookup can never drift apart.
    const templateSlug = getPageProbeTemplateSlug();
    const templateUuid = await getCachedTemplateUuid(templateSlug, async () => {
      return client.workflows!.findTemplateBySlug(templateSlug);
    });
    if (!templateUuid) {
      throw new Error(
        `Page Probe Workflow Template not found (slug "${templateSlug}"). ` +
        `Ensure the backend has that template seeded and accessible ` +
        `(GET /api/v1/workflows/?slug=${templateSlug}).`,
      );
    }

    // ── Group targets by shared Caddy route (§4 multi-port batch decision) ──
    // Single-group batches (the common case — one port, or all-public) behave
    // EXACTLY as before: one repoint (if localhost), one backend execution.
    // Multi-group batches decompose into one sequential
    // acquirePortRoute → executeWorkflow(subset) → poll → releasePortRoute
    // cycle per group — slower (N backend round-trips) but correct, rather
    // than hard-rejecting a batch shape that worked when it was single-port.
    const groups = groupTargetsByRoute(targetContexts);

    // ── Execute (queuing progress step, once — shared across all groups) ───
    if (progressCallback) {
      await progressCallback({ progress: ++progressStep, total: TOTAL_STEPS, message: 'Queuing workflow execution...' });
    }

    const results: ProbePageResult[] = new Array(input.targets.length);
    const captureDataByIndex: any[] = new Array(input.targets.length);
    const executionIds: string[] = [];
    const browserSessions: any[] = [];
    let lastExecutionDurationMs: number | undefined;
    let completedOffset = 0;

    for (const group of groups) {
      // §2.4: acquire this session's shared Caddy route for the group's port
      // BEFORE dispatching — held for the group's whole execute+poll cycle,
      // not just the repoint. No-op (undefined) for the 'public' group.
      let groupCtx: TunnelContext | undefined;
      if (group.needsRoute) {
        const representative = targetContexts[group.indices[0]];
        groupCtx = await acquirePortRoute(representative, {
          callId: `${callId}:${group.key}`,
          signal: abortController.signal,
          onWaitProgress: progressCallback
            ? async (info) => {
                await progressCallback({
                  progress: Math.min(progressStep + completedOffset, TOTAL_STEPS - 1),
                  total: TOTAL_STEPS,
                  message: `Waiting for shared tunnel — port ${info.blockingPort} is in use (waited ${Math.round(info.waitedMs / 1000)}s)...`,
                });
              }
            : undefined,
        });
      }

      try {
        // Tunnel health probe: catch the IPv4/IPv6 bind / dead-server case
        // before committing to a full backend execution. Must run AFTER
        // acquirePortRoute (above) confirms Caddy is actually pointed at this
        // group's port — probing any earlier would probe whatever port Caddy
        // happened to be pointed at a moment ago, not this one (see
        // utils/tunnelContext.ts's acquirePortRoute doc comment).
        if (groupCtx?.targetUrl) {
          const health = await probeTunnelHealth(groupCtx.targetUrl);
          if (!health.healthy) {
            const payload = {
              error: 'TunnelTrafficBlocked',
              message: `Tunnel established but traffic isn't reaching the dev server. ${health.detail ?? ''}`,
              detail: {
                code: health.code,
                status: health.status,
                ngrokErrorCode: health.ngrokErrorCode,
                elapsedMs: health.elapsedMs,
              },
            };
            // Evict ONLY on a code proving the endpoint is gone; every other
            // failure keeps the tunnel we are already paying for, since a
            // teardown+re-provision costs two billed hours and this probe
            // cannot tell a dead endpoint from a transient edge flake. See
            // utils/tunnelDisposition.ts for the allowlist and the evidence.
            disposeUnhealthyTunnel({ health, tunnelId: groupCtx.tunnelId, originalUrl: groupCtx.originalUrl });
            return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
          }
        }

        // ── Build contextData for THIS group's subset (camelCase; axiosTransport
        // snake_cases on the wire) ──────────────────────────────────────────
        // Backend's browser.setup node (shared with App Evaluation + Raw Crawl
        // templates) requires `target_url` (singular). Send BOTH:
        //   - targetUrl: this group's first target's tunneled URL (satisfies
        //     browser.setup today; will keep working when the loop wraps it later)
        //   - targets[]: the full per-URL config for when the loop primitive
        //     ships and iterates over them
        const groupTargets = group.indices.map(i => input.targets[i]);
        const firstTargetUrl = targetContexts[group.indices[0]]?.targetUrl ?? groupTargets[0].url;
        const contextData: Record<string, any> = {
          targetUrl: firstTargetUrl,
          targets: group.indices.map(i => ({
            url: targetContexts[i].targetUrl ?? input.targets[i].url,
            // Send null (not undefined) for optional fields so the field exists
            // in the target object even when the caller didn't pass one. Backend
            // placeholder resolver was fixed in commit 154e1e69 to type-preserve
            // null in single-placeholder substitutions, so null flows through.
            waitForSelector: input.targets[i].waitForSelector ?? null,
            waitForLoadState: input.targets[i].waitForLoadState,
            timeoutMs: input.targets[i].timeoutMs,
          })),
          // Backend's browser.capture template binds {{include_dom}} and
          // {{include_screenshot}} from contextData (verified 2026-04-29).
          // The MCP-facing schema keeps `includeHtml` / `captureScreenshots`
          // for caller ergonomics; we just map them to what the template wants.
          includeDom: input.includeHtml,
          includeScreenshot: input.captureScreenshots,
          // Keep the original keys too for any downstream node that reads them
          // (cheap to send, future-proof against template field-name churn).
          includeHtml: input.includeHtml,
          captureScreenshots: input.captureScreenshots,
        };

        const executeResponse = await client.workflows!.executeWorkflow(templateUuid, contextData);
        const executionUuid = executeResponse.executionUuid;
        executionIds.push(executionUuid);
        logger.info(`Probe execution queued: ${executionUuid} (group ${group.key}, ${group.indices.length} target(s))`);

        // ── Poll ───────────────────────────────────────────────────────────
        let lastCompletedInGroup = -1;
        const finalExecution = await client.workflows!.pollExecution(executionUuid, async (exec) => {
          // Keep this group's active tunnels alive during polling.
          for (const i of group.indices) {
            const tunnelId = targetContexts[i].tunnelId;
            if (tunnelId) touchTunnelById(tunnelId);
          }

          if (!progressCallback) return;

          const completedNodes = (exec.nodeExecutions ?? []).filter(
            n => n.nodeType === 'browser.capture' && n.status === 'success',
          ).length;
          if (completedNodes !== lastCompletedInGroup) {
            lastCompletedInGroup = completedNodes;
            const totalCompleted = completedOffset + completedNodes;
            await progressCallback({
              progress: Math.min(progressStep + totalCompleted, TOTAL_STEPS - 1),
              total: TOTAL_STEPS,
              message: `Probed ${totalCompleted}/${input.targets.length} target${input.targets.length === 1 ? '' : 's'}...`,
            });
          }
        }, abortController.signal);

        lastExecutionDurationMs = finalExecution.durationMs ?? undefined;
        if (finalExecution.browserSession) browserSessions.push(finalExecution.browserSession);

        // ── Format this group's results into the shared, ORIGINAL-order arrays ──
        const captureNodes = (finalExecution.nodeExecutions ?? [])
          .filter(n => n.nodeType === 'browser.capture')
          .sort((a, b) => a.executionOrder - b.executionOrder);

        for (let gi = 0; gi < group.indices.length; gi++) {
          const originalIndex = group.indices[gi];
          const target = input.targets[originalIndex];
          const node = captureNodes[gi];
          const data: any = node?.outputData ?? {};
          captureDataByIndex[originalIndex] = data;

          // Backend (post-154e1e69) emits browser.capture output_data with:
          //   captured_url, status_code, title, load_time_ms,
          //   console_slice (already per-capture, in {text, level, location, timestamp} shape),
          //   network_summary (already pre-aggregated by FULL URL,
          //                    in {url, count, methods[], statuses{}, resource_types[]} shape),
          //   surfer_page_uuid (reference to SurferPage row for screenshot/title/visible_text),
          //   error
          // axiosTransport snake→camel'd at the wire, so JS-side these are
          // capturedUrl / consoleSlice / networkSummary / surferPageUuid / etc.
          // Re-aggregate networkSummary by origin+pathname so refetch loops
          // collapse (preserves the original client-feedback contract).
          const result: ProbePageResult = {
            url: target.url, // ORIGINAL caller URL — not the tunneled rewrite
            finalUrl: typeof data.capturedUrl === 'string' ? data.capturedUrl
                    : typeof data.finalUrl === 'string' ? data.finalUrl
                    : typeof data.url === 'string' ? data.url
                    : target.url,
            statusCode: typeof data.statusCode === 'number' ? data.statusCode : 0,
            title: typeof data.title === 'string' ? data.title : null,
            loadTimeMs: typeof data.loadTimeMs === 'number' ? data.loadTimeMs : 0,
            consoleErrors: mapConsoleSlice(Array.isArray(data.consoleSlice) ? data.consoleSlice : []),
            networkSummary: reaggregateByOriginPath(Array.isArray(data.networkSummary) ? data.networkSummary : []),
          };

          if (input.includeHtml && typeof data.html === 'string') {
            result.html = data.html;
          }
          if (typeof data.error === 'string' && data.error) {
            result.error = data.error;
          }
          if (typeof data.surferPageUuid === 'string' && data.surferPageUuid) {
            result.surferPageUuid = data.surferPageUuid;
          }

          // Bead debugg_ai_mcp-6cfv.6 fix: sanitize each result against ITS
          // OWN target's tunnel context, never the whole accumulated payload.
          // Under the old per-port-tunnel model every target had a distinct
          // hostname, so rewriting the whole payload on each pass was safe by
          // accident. Under the new session-tunnel model every localhost
          // target in a batch can share ONE hostname — sanitizing the whole
          // payload with target A's context would also rewrite target B's own
          // (correct) occurrences, a cross-target data leak. Scoping the
          // sanitize call to `result`'s own subtree, keyed by `targetContexts[originalIndex]`,
          // makes that leak structurally impossible regardless of how many
          // targets share a hostname.
          const tc = targetContexts[originalIndex];
          results[originalIndex] = tc.isLocalhost ? (sanitizeResponseUrls(result, tc) as ProbePageResult) : result;
        }

        completedOffset += group.indices.length;
      } finally {
        if (groupCtx) releasePortRoute(groupCtx);
      }
    }

    // ── Format response ────────────────────────────────────────────────────
    const duration = Date.now() - startTime;

    const responsePayload: Record<string, any> = {
      executionId: executionIds[0],
      // Single-group batches (every existing caller) keep the exact prior
      // semantics: the backend's own reported durationMs when present, wall
      // clock otherwise. Multi-group batches use wall clock — summing/picking
      // among several backend-reported per-execution durations would be
      // misleading, since the executions ran sequentially, not concurrently.
      durationMs: groups.length === 1 && typeof lastExecutionDurationMs === 'number'
        ? lastExecutionDurationMs
        : duration,
      results,
    };
    // Multi-group batches ran more than one backend execution — surface all
    // of their ids/sessions additively, without changing the single-group
    // (single-execution) response shape any existing caller already parses.
    if (executionIds.length > 1) responsePayload.executionIds = executionIds;
    if (browserSessions.length === 1) {
      responsePayload.browserSession = browserSessions[0];
    } else if (browserSessions.length > 1) {
      responsePayload.browserSessions = browserSessions;
    }

    logger.toolComplete('probe_page', duration);

    const responseContent: ToolResponse['content'] = [
      { type: 'text', text: JSON.stringify(responsePayload, null, 2) },
    ];

    // Embed screenshots when captureScreenshots is true. The backend may return
    // screenshotB64 or a URL-keyed field on browser.capture outputData.
    if (input.captureScreenshots) {
      const SCREENSHOT_URL_KEYS = ['screenshotB64', 'screenshot', 'screenshotUrl', 'screenshotUri', 'finalScreenshot'];
      for (const data of captureDataByIndex) {
        if (!data) continue;
        if (typeof data.screenshotB64 === 'string' && data.screenshotB64) {
          responseContent.push(imageContentBlock(data.screenshotB64, 'image/png'));
        } else {
          let screenshotUrl: string | null = null;
          for (const key of SCREENSHOT_URL_KEYS) {
            if (key !== 'screenshotB64' && typeof data[key] === 'string' && data[key]) {
              screenshotUrl = data[key] as string;
              break;
            }
          }
          if (screenshotUrl) {
            const img = await fetchImageAsBase64(screenshotUrl).catch(() => null);
            if (img) responseContent.push(imageContentBlock(img.data, img.mimeType));
          }
        }
      }
    }

    return { content: responseContent };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('probe_page', error as Error, duration);

    if (error instanceof Error && (error.message.includes('not found') || error.message.includes('401'))) {
      invalidateTemplateCache();
    }
    throw handleExternalServiceError(error, 'DebuggAI', 'probe_page execution');
  } finally {
    if (requestSignal) requestSignal.removeEventListener('abort', onAbort);
    // Tunnels intentionally NOT torn down — reuse pattern (bead vwd) +
    // 55-min idle auto-shutoff. Revoke only orphaned keys (we acquired the
    // key but tunnel creation failed before ensureTunnel completed).
    for (let i = 0; i < acquiredKeyIds.length; i++) {
      const keyId = acquiredKeyIds[i];
      const tc = targetContexts[i];
      if (tc && !tc.tunnelId && keyId) {
        client.revokeNgrokKey(keyId).catch(err =>
          logger.warn(`Failed to revoke unused ngrok key ${keyId}: ${err}`),
        );
      }
    }
  }
}
