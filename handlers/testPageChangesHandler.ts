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
import { fetchImageAsBase64, imageContentBlock } from '../utils/imageUtils.js';
import { DebuggAIServerClient } from '../services/index.js';
import {
  resolveTargetUrl,
  buildContext,
  ensureTunnel,
  releaseTunnel,
  sanitizeResponseUrls,
} from '../utils/tunnelContext.js';

const logger = new Logger({ module: 'testPageChangesHandler' });

// Cache the template UUID within a server session to avoid re-fetching
let cachedTemplateUuid: string | null = null;

export async function testPageChangesHandler(
  input: TestPageChangesInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('check_app_in_browser', input);

  const client = new DebuggAIServerClient(config.api.key);
  await client.init();

  const originalUrl = resolveTargetUrl(input);
  let ctx = buildContext(originalUrl);
  let ngrokKeyId: string | undefined;

  const abortController = new AbortController();
  const onStdinClose = () => abortController.abort();
  process.stdin.once('close', onStdinClose);

  try {
    // --- Find workflow template ---
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 10, message: 'Locating evaluation workflow template...' });
    }

    if (!cachedTemplateUuid) {
      const template = await client.workflows!.findEvaluationTemplate();
      if (!template) {
        throw new Error(
          'App Evaluation Workflow Template not found. ' +
          'Ensure the template is seeded in the backend (GET /api/v1/workflows/?is_template=true).'
        );
      }
      cachedTemplateUuid = template.uuid;
      logger.info(`Using workflow template: ${template.name} (${template.uuid})`);
    }

    // --- Build context data ---
    const contextData: Record<string, any> = {
      targetUrl: originalUrl,
      goal: input.description,
    };

    // --- Build env (credentials/environment) ---
    const env: Record<string, any> = {};
    if (input.environmentId) env.environmentId = input.environmentId;
    if (input.credentialId) env.credentialId = input.credentialId;
    if (input.credentialRole) env.credentialRole = input.credentialRole;
    if (input.username) env.username = input.username;
    if (input.password) env.password = input.password;

    // --- Execute ---
    if (progressCallback) {
      await progressCallback({ progress: 2, total: 10, message: 'Queuing workflow execution...' });
    }

    const executeResponse = await client.workflows!.executeWorkflow(
      cachedTemplateUuid,
      contextData,
      Object.keys(env).length > 0 ? env : undefined
    );
    const executionUuid = executeResponse.executionUuid;
    ngrokKeyId = executeResponse.ngrokKeyId ?? undefined;
    logger.info(`Execution queued: ${executionUuid}`);

    // --- Tunnel (after execute — backend returns tunnelKey, executionUuid is the subdomain) ---
    if (ctx.isLocalhost) {
      if (progressCallback) {
        await progressCallback({ progress: 3, total: 10, message: 'Creating secure tunnel for localhost...' });
      }
      if (!executeResponse.tunnelKey) {
        throw new Error('Backend did not return a tunnel key for localhost execution');
      }
      ctx = await ensureTunnel(ctx, executeResponse.tunnelKey, executionUuid);
      logger.info(`Tunnel ready for ${originalUrl} (id: ${executionUuid})`);
    }

    // --- Poll ---
    // nodeExecutions grows as each node completes: trigger → browser.setup → surfer.execute_task → browser.teardown
    const NODE_PHASE_LABELS: Record<number, string> = {
      0: 'Browser agent starting up...',
      1: 'Browser ready, agent navigating...',
      2: 'Agent evaluating app...',
      3: 'Wrapping up...',
    };
    let lastNodeCount = 0;
    const finalExecution = await client.workflows!.pollExecution(executionUuid, async (exec) => {
      const nodeCount = exec.nodeExecutions?.length ?? 0;
      if (nodeCount !== lastNodeCount || exec.status !== 'pending') {
        lastNodeCount = nodeCount;
        logger.info(`Execution status: ${exec.status}, nodes completed: ${nodeCount}`);
      }
      if (progressCallback) {
        // Map 0-4 completed nodes to progress 3-9 (3 reserved for tunnel setup)
        const progress = Math.min(3 + nodeCount * 2, 9);
        const message = exec.status === 'running'
          ? (NODE_PHASE_LABELS[nodeCount] ?? 'Agent working...')
          : exec.status;
        await progressCallback({ progress, total: 10, message });
      }
    }, abortController.signal);

    const duration = Date.now() - startTime;

    // --- Format result ---
    const outcome = finalExecution.state?.outcome ?? finalExecution.status;
    const surferNode = finalExecution.nodeExecutions?.find(
      n => n.nodeType === 'surfer.execute_task'
    );

    const responsePayload: Record<string, any> = {
      outcome,
      success: finalExecution.state?.success ?? false,
      status: finalExecution.status,
      stepsTaken: finalExecution.state?.stepsTaken ?? surferNode?.outputData?.stepsTaken ?? 0,
      targetUrl: originalUrl,
      executionId: executionUuid,
      durationMs: finalExecution.durationMs ?? duration,
    };

    if (finalExecution.state?.error) responsePayload.agentError = finalExecution.state.error;
    if (finalExecution.errorMessage) responsePayload.errorMessage = finalExecution.errorMessage;
    if (finalExecution.errorInfo?.failedNodeId) responsePayload.failedNode = finalExecution.errorInfo.failedNodeId;
    if (executeResponse.resolvedEnvironmentId) responsePayload.resolvedEnvironmentId = executeResponse.resolvedEnvironmentId;
    if (executeResponse.resolvedCredentialId) responsePayload.resolvedCredentialId = executeResponse.resolvedCredentialId;
    if (surferNode?.outputData) {
      responsePayload.surferOutput = sanitizeResponseUrls(surferNode.outputData, ctx);
    }

    logger.toolComplete('check_app_in_browser', duration);

    if (progressCallback) {
      await progressCallback({ progress: 10, total: 10, message: `Complete: ${outcome}` });
    }

    const content: ToolResponse['content'] = [
      { type: 'text', text: JSON.stringify(responsePayload, null, 2) },
    ];

    // Embed screenshot / GIF from the surfer node output when URLs are present
    const outputData = surferNode?.outputData ?? {};
    const screenshotUrl: string | null =
      outputData.finalScreenshot ?? outputData.screenshot ?? outputData.screenshotUrl ?? null;
    const gifUrl: string | null = outputData.runGif ?? outputData.gifUrl ?? null;

    if (screenshotUrl) {
      const img = await fetchImageAsBase64(screenshotUrl).catch(() => null);
      if (img) content.push(imageContentBlock(img.data, img.mimeType));
    }
    if (gifUrl) {
      const gif = await fetchImageAsBase64(gifUrl).catch(() => null);
      if (gif) content.push(imageContentBlock(gif.data, 'image/gif'));
    }

    return { content };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('check_app_in_browser', error as Error, duration);

    if (error instanceof Error && (error.message.includes('not found') || error.message.includes('401'))) {
      cachedTemplateUuid = null;
    }

    throw handleExternalServiceError(error, 'DebuggAI', 'test execution');
  } finally {
    process.stdin.removeListener('close', onStdinClose);
    if (ngrokKeyId) {
      client.revokeNgrokKey(ngrokKeyId).catch(err =>
        logger.warn(`Failed to revoke ngrok key ${ngrokKeyId}: ${err}`)
      );
    }
    releaseTunnel(ctx).catch(err =>
      logger.warn(`Failed to stop tunnel: ${err}`)
    );
  }
}
