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
import { tunnelManager } from '../services/ngrok/tunnelManager.js';
import { probeLocalPort, probeTunnelHealth } from '../utils/localReachability.js';
import { extractLocalhostPort } from '../utils/urlParser.js';
import {
  buildContext,
  findExistingTunnel,
  ensureTunnel,
  sanitizeResponseUrls,
  touchTunnelById,
  TunnelContext,
} from '../utils/tunnelContext.js';
import { getCachedTemplateUuid, invalidateTemplateCache } from '../utils/handlerCaches.js';
import { reaggregateByOriginPath, mapConsoleSlice } from '../utils/harSummarizer.js';
import { fetchImageAsBase64, imageContentBlock } from '../utils/imageUtils.js';

const logger = new Logger({ module: 'probePageHandler' });

const TEMPLATE_KEYWORD = 'page probe';

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

  const abortController = new AbortController();
  const onStdinClose = () => {
    abortController.abort();
    progressDisabled = true;
  };
  process.stdin.once('close', onStdinClose);

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

          // Tunnel health probe: catch the IPv4/IPv6 bind / dead-server case
          // before committing to a full backend execution.
          if (tunneled.targetUrl) {
            const health = await probeTunnelHealth(tunneled.targetUrl);
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
              if (tunneled.tunnelId) {
                tunnelManager.stopTunnel(tunneled.tunnelId).catch((err) =>
                  logger.warn(`Failed to stop broken tunnel ${tunneled.tunnelId}: ${err}`),
                );
              }
              return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
            }
          }

          targetContexts.push(tunneled);
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

    const templateUuid = await getCachedTemplateUuid(TEMPLATE_KEYWORD, async (name) => {
      return client.workflows!.findTemplateByName(name);
    });
    if (!templateUuid) {
      throw new Error(
        `Page Probe Workflow Template not found. ` +
        `Ensure the backend has a template matching "${TEMPLATE_KEYWORD}" seeded and accessible.`,
      );
    }

    // ── Build contextData (camelCase; axiosTransport snake_cases on the wire) ──
    // Backend's browser.setup node (shared with App Evaluation + Raw Crawl
    // templates) requires `target_url` (singular). The Page Probe template
    // currently uses that node as-is — the per-target loop primitive is
    // pending. Send BOTH:
    //   - targetUrl: first target's tunneled URL (satisfies browser.setup
    //     today; will keep working when the loop wraps it later)
    //   - targets[]: the full per-URL config for when the loop primitive
    //     ships and iterates over them
    const firstTargetUrl = targetContexts[0]?.targetUrl ?? input.targets[0].url;
    const contextData: Record<string, any> = {
      targetUrl: firstTargetUrl,
      targets: input.targets.map((t, i) => ({
        url: targetContexts[i].targetUrl ?? t.url,
        // Send null (not undefined) for optional fields so the field exists
        // in the target object even when the caller didn't pass one. Backend
        // placeholder resolver was fixed in commit 154e1e69 to type-preserve
        // null in single-placeholder substitutions, so null flows through.
        waitForSelector: t.waitForSelector ?? null,
        waitForLoadState: t.waitForLoadState,
        timeoutMs: t.timeoutMs,
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

    // ── Execute ────────────────────────────────────────────────────────────
    if (progressCallback) {
      await progressCallback({ progress: ++progressStep, total: TOTAL_STEPS, message: 'Queuing workflow execution...' });
    }

    const executeResponse = await client.workflows!.executeWorkflow(templateUuid, contextData);
    const executionUuid = executeResponse.executionUuid;
    logger.info(`Probe execution queued: ${executionUuid}`);

    // ── Poll ───────────────────────────────────────────────────────────────
    let lastCompleted = -1;
    const finalExecution = await client.workflows!.pollExecution(executionUuid, async (exec) => {
      // Keep all active tunnels alive during polling.
      for (const tc of targetContexts) {
        if (tc.tunnelId) touchTunnelById(tc.tunnelId);
      }

      if (!progressCallback) return;

      const completedNodes = (exec.nodeExecutions ?? []).filter(
        n => n.nodeType === 'browser.capture' && n.status === 'success',
      ).length;
      if (completedNodes !== lastCompleted) {
        lastCompleted = completedNodes;
        await progressCallback({
          progress: Math.min(progressStep + completedNodes, TOTAL_STEPS - 1),
          total: TOTAL_STEPS,
          message: `Probed ${completedNodes}/${input.targets.length} target${input.targets.length === 1 ? '' : 's'}...`,
        });
      }
    }, abortController.signal);

    // ── Format response ────────────────────────────────────────────────────
    const duration = Date.now() - startTime;
    const captureNodes = (finalExecution.nodeExecutions ?? [])
      .filter(n => n.nodeType === 'browser.capture')
      .sort((a, b) => a.executionOrder - b.executionOrder);

    const results: ProbePageResult[] = [];

    for (let i = 0; i < input.targets.length; i++) {
      const target = input.targets[i];
      const node = captureNodes[i];
      const data: any = node?.outputData ?? {};

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

      results.push(result);
    }

    const responsePayload: Record<string, any> = {
      executionId: executionUuid,
      durationMs: typeof finalExecution.durationMs === 'number' ? finalExecution.durationMs : duration,
      results,
    };

    if (finalExecution.browserSession) {
      responsePayload.browserSession = finalExecution.browserSession;
    }

    // Sanitize ngrok URLs from the entire payload — agent-authored strings in
    // node outputData (titles, HTML, console messages from the page itself)
    // can occasionally contain the tunnel URL; rewrite to the original
    // localhost origin per tunnel context. For multi-localhost batches we
    // run sanitize once per localhost target since each may have its own
    // tunnel↔origin mapping.
    let sanitizedPayload: any = responsePayload;
    for (const tc of targetContexts) {
      if (tc.isLocalhost) {
        sanitizedPayload = sanitizeResponseUrls(sanitizedPayload, tc);
      }
    }

    logger.toolComplete('probe_page', duration);

    const responseContent: ToolResponse['content'] = [
      { type: 'text', text: JSON.stringify(sanitizedPayload, null, 2) },
    ];

    // Embed screenshots when captureScreenshots is true. The backend may return
    // screenshotB64 or a URL-keyed field on browser.capture outputData.
    if (input.captureScreenshots) {
      const SCREENSHOT_URL_KEYS = ['screenshotB64', 'screenshot', 'screenshotUrl', 'screenshotUri', 'finalScreenshot'];
      for (const node of captureNodes) {
        const data: any = node?.outputData ?? {};
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
    process.stdin.removeListener('close', onStdinClose);
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
