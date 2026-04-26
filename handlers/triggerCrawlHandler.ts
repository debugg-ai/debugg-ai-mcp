/**
 * Trigger Crawl Handler
 *
 * Executes the Raw Crawl Workflow Template via the 4-step pattern shared with
 * testPageChangesHandler:
 *   find template → provision tunnel if localhost → execute → poll → result
 *
 * Unlike check_app_in_browser, a crawl does NOT return pass/fail — it returns
 * the execution status + metadata. The backend's job is to explore the app
 * and populate the project knowledge graph; this handler just triggers it
 * and reports back what happened.
 */

import {
  TriggerCrawlInput,
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
  resolveTargetUrl,
  buildContext,
  findExistingTunnel,
  ensureTunnel,
  sanitizeResponseUrls,
  touchTunnelById,
} from '../utils/tunnelContext.js';

const logger = new Logger({ module: 'triggerCrawlHandler' });

const TEMPLATE_KEYWORD = 'raw crawl';

export async function triggerCrawlHandler(
  input: TriggerCrawlInput,
  context: ToolContext,
  rawProgressCallback?: ProgressCallback,
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('trigger_crawl', input);

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

  const originalUrl = resolveTargetUrl(input);
  let ctx = buildContext(originalUrl);
  let keyId: string | undefined;

  const abortController = new AbortController();
  const onStdinClose = () => {
    abortController.abort();
    progressDisabled = true;
  };
  process.stdin.once('close', onStdinClose);

  try {
    // --- Tunnel: reuse existing or provision a fresh one ---
    if (ctx.isLocalhost) {
      // Bead 1om: pre-flight local port probe BEFORE provision/ngrok/backend.
      const localPort = extractLocalhostPort(ctx.originalUrl);
      if (typeof localPort === 'number') {
        const probe = await probeLocalPort(localPort);
        if (!probe.reachable) {
          const payload = {
            error: 'LocalServerUnreachable',
            message: `No server listening on 127.0.0.1:${localPort}. Start your dev server on that port before running trigger_crawl. Probe result: ${probe.code} (${probe.detail ?? 'no detail'}).`,
            detail: { port: localPort, probeCode: probe.code, probeDetail: probe.detail, elapsedMs: probe.elapsedMs },
          };
          logger.warn(`Pre-flight port probe failed for ${ctx.originalUrl}: ${probe.code} in ${probe.elapsedMs}ms`);
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
        }
      }

      if (progressCallback) {
        await progressCallback({ progress: 1, total: 4, message: 'Provisioning secure tunnel for localhost...' });
      }

      const reused = findExistingTunnel(ctx);
      if (reused) {
        ctx = reused;
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
            `(Detail: ${msg})${diag}`,
          );
        }
        keyId = tunnel.keyId;
        ctx = await ensureTunnel(
          ctx,
          tunnel.tunnelKey,
          tunnel.tunnelId,
          tunnel.keyId,
          () => client.revokeNgrokKey(tunnel.keyId),
        );
      }

      // Bead 1om: post-tunnel health check — verify traffic actually flows.
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
          if (ctx.tunnelId) {
            tunnelManager.stopTunnel(ctx.tunnelId).catch((err) =>
              logger.warn(`Failed to stop broken tunnel ${ctx.tunnelId}: ${err}`),
            );
          }
          keyId = undefined;
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
        }
      }
    }

    // --- Find the crawl workflow template ---
    if (progressCallback) {
      await progressCallback({ progress: 2, total: 4, message: 'Locating crawl workflow template...' });
    }

    const template = await client.workflows!.findTemplateByName(TEMPLATE_KEYWORD);
    if (!template) {
      throw new Error(
        `Raw Crawl Workflow Template not found. ` +
        `Ensure the backend has a template matching "${TEMPLATE_KEYWORD}" seeded and accessible.`,
      );
    }
    const templateUuid = template.uuid;
    logger.info(`Using crawl template: ${template.name} (${templateUuid})`);

    // --- Build contextData + env ---
    const contextData: Record<string, any> = {
      targetUrl: ctx.targetUrl ?? ctx.originalUrl,
    };
    if (input.projectUuid) contextData.projectId = input.projectUuid;
    if (typeof input.headless === 'boolean') contextData.headless = input.headless;
    if (typeof input.timeoutSeconds === 'number') contextData.timeoutSeconds = input.timeoutSeconds;

    const env: Record<string, any> = {};
    if (input.environmentId) env.environmentId = input.environmentId;
    if (input.credentialId) env.credentialId = input.credentialId;
    if (input.credentialRole) env.credentialRole = input.credentialRole;
    if (input.username) env.username = input.username;
    if (input.password) env.password = input.password;

    // --- Execute ---
    if (progressCallback) {
      await progressCallback({ progress: 3, total: 4, message: 'Queuing crawl execution...' });
    }

    const executeResponse = await client.workflows!.executeWorkflow(
      templateUuid,
      contextData,
      Object.keys(env).length > 0 ? env : undefined,
    );
    const executionUuid = executeResponse.executionUuid;
    logger.info(`Crawl execution queued: ${executionUuid}`);

    // --- Poll ---
    // Bead 0bq: emit the final progress (4/4 "Complete:...") INSIDE onUpdate
    // when terminal status detected, so there's no post-resolve emission that
    // could race the response and cause stale-progressToken transport tear-down.
    const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
    const finalExecution = await client.workflows!.pollExecution(executionUuid, async (exec) => {
      if (ctx.tunnelId) touchTunnelById(ctx.tunnelId);
      if (!progressCallback) return;
      const nodeCount = (exec.nodeExecutions ?? []).length;
      if (TERMINAL_STATUSES.has(exec.status)) {
        await progressCallback({
          progress: 4, total: 4,
          message: `Crawl ${exec.status} (${nodeCount} nodes)`,
        });
        return;
      }
      await progressCallback({
        progress: 4, total: 4,
        message: `Crawl ${exec.status} (${nodeCount} nodes)`,
      });
    }, abortController.signal);

    const duration = Date.now() - startTime;
    const nodes = finalExecution.nodeExecutions ?? [];

    // --- Format response ---
    const responsePayload: Record<string, any> = {
      executionId: executionUuid,
      status: finalExecution.status,
      targetUrl: ctx.originalUrl,
      durationMs: finalExecution.durationMs ?? duration,
    };
    const outcome = finalExecution.state?.outcome;
    if (outcome !== undefined && outcome !== null) responsePayload.outcome = outcome;
    if (finalExecution.errorMessage) responsePayload.errorMessage = finalExecution.errorMessage;
    if (finalExecution.errorInfo?.failedNodeId) responsePayload.failedNode = finalExecution.errorInfo.failedNodeId;
    if (executeResponse.resolvedEnvironmentId) responsePayload.resolvedEnvironmentId = executeResponse.resolvedEnvironmentId;
    if (executeResponse.resolvedCredentialId) responsePayload.resolvedCredentialId = executeResponse.resolvedCredentialId;
    // Backend release 2026-04-25: browser_session block on execution detail.
    // Crawl runs through the same browser pipeline, so the field is populated
    // here too. Pass through verbatim (presigned S3 URLs).
    if (finalExecution.browserSession) {
      responsePayload.browserSession = finalExecution.browserSession;
    }

    // Extract crawl metrics from surfer.crawl node (absent in older graph shapes)
    const crawlNode = nodes.find(n => n.nodeType === 'surfer.crawl');
    if (crawlNode?.outputData) {
      const d = crawlNode.outputData;
      responsePayload.crawlSummary = {
        pagesDiscovered: d.pagesDiscovered,
        actionsExecuted: d.actionsExecuted,
        stepsTaken: d.stepsTaken,
        transitionsRecorded: d.transitionsRecorded,
        knowledgeGraphStates: d.knowledgeGraphStates,
        success: d.success,
        ...(d.error ? { error: d.error } : {}),
      };
    }

    // Extract KG import result from knowledge_graph.import node (absent in older graph shapes)
    const kgNode = nodes.find(n => n.nodeType === 'knowledge_graph.import');
    if (kgNode?.outputData) {
      const d = kgNode.outputData;
      responsePayload.knowledgeGraph = {
        imported: !d.skipped,
        skipped: d.skipped ?? false,
        reason: d.reason ?? '',
        edgesImported: d.edgesImported ?? 0,
        statesImported: d.statesImported ?? 0,
        knowledgeGraphId: d.knowledgeGraphId ?? '',
        ...(Array.isArray(d.importErrors) && d.importErrors.length > 0 ? { importErrors: d.importErrors } : {}),
      };
    }

    logger.toolComplete('trigger_crawl', duration);
    // Bead 0bq: final progress is emitted INSIDE pollExecution's onUpdate when
    // terminal status is detected. Emitting it here would race the response
    // and could cause stale-progressToken transport tear-down.

    const sanitizedPayload = sanitizeResponseUrls(responsePayload, ctx);
    return {
      content: [{ type: 'text', text: JSON.stringify(sanitizedPayload, null, 2) }],
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('trigger_crawl', error as Error, duration);
    throw handleExternalServiceError(error, 'DebuggAI', 'crawl execution');
  } finally {
    process.stdin.removeListener('close', onStdinClose);
    // Tunnel intentionally NOT torn down (reuse path per bead vwd).
    // If tunnel creation failed after key provision, revoke the orphaned key.
    if (!ctx.tunnelId && keyId) {
      client.revokeNgrokKey(keyId).catch(err =>
        logger.warn(`Failed to revoke unused ngrok key ${keyId}: ${err}`),
      );
    }
  }
}
