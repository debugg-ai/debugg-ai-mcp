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
  progressCallback?: ProgressCallback,
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('trigger_crawl', input);

  const client = new DebuggAIServerClient(config.api.key);
  await client.init();

  const originalUrl = resolveTargetUrl(input);
  let ctx = buildContext(originalUrl);
  let keyId: string | undefined;

  const abortController = new AbortController();
  const onStdinClose = () => abortController.abort();
  process.stdin.once('close', onStdinClose);

  try {
    // --- Tunnel: reuse existing or provision a fresh one ---
    if (ctx.isLocalhost) {
      if (progressCallback) {
        await progressCallback({ progress: 1, total: 4, message: 'Provisioning secure tunnel for localhost...' });
      }

      const reused = findExistingTunnel(ctx);
      if (reused) {
        ctx = reused;
      } else {
        let tunnel;
        try {
          tunnel = await client.tunnels!.provision();
        } catch (provisionError) {
          const msg = provisionError instanceof Error ? provisionError.message : String(provisionError);
          throw new Error(
            `Failed to provision tunnel for ${ctx.originalUrl}. ` +
            `The remote browser needs a secure tunnel to reach your local dev server. ` +
            `(Detail: ${msg})`,
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
    const finalExecution = await client.workflows!.pollExecution(executionUuid, async (exec) => {
      if (ctx.tunnelId) touchTunnelById(ctx.tunnelId);
      if (!progressCallback) return;
      const nodeCount = (exec.nodeExecutions ?? []).length;
      await progressCallback({
        progress: 4,
        total: 4,
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

    if (progressCallback) {
      await progressCallback({ progress: 4, total: 4, message: `Crawl ${finalExecution.status}` });
    }

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
