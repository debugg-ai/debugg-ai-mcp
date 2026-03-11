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
  findExistingTunnel,
  ensureTunnel,
  sanitizeResponseUrls,
  touchTunnelById,
} from '../utils/tunnelContext.js';

const logger = new Logger({ module: 'testPageChangesHandler' });

// Cache the template UUID and project UUID within a server session to avoid re-fetching
let cachedTemplateUuid: string | null = null;
let cachedProjectUuid: string | null = null;

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
  let keyId: string | undefined;

  const abortController = new AbortController();
  const onStdinClose = () => abortController.abort();
  process.stdin.once('close', onStdinClose);

  // Progress budget: 3 setup steps + 25 execution steps = 28 total
  const SETUP_STEPS = 3;
  const MAX_EXEC_STEPS = 25;
  const TOTAL_STEPS = SETUP_STEPS + MAX_EXEC_STEPS;

  try {
    // --- Tunnel: reuse existing or provision a fresh one ---
    if (ctx.isLocalhost) {
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
          tunnel = await client.tunnels!.provision();
        } catch (provisionError) {
          const msg = provisionError instanceof Error ? provisionError.message : String(provisionError);
          throw new Error(
            `Failed to provision tunnel for ${ctx.originalUrl}. ` +
            `The remote browser needs a secure tunnel to reach your local dev server. ` +
            `Make sure your dev server is running on the specified port and try again. ` +
            `(Detail: ${msg})`
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
    }

    // --- Find workflow template ---
    if (progressCallback) {
      await progressCallback({ progress: 2, total: TOTAL_STEPS, message: 'Locating evaluation workflow template...' });
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

    // --- Resolve project UUID (best-effort, non-blocking) ---
    if (!cachedProjectUuid && config.defaults.repoName) {
      try {
        const project = await client.findProjectByRepoName(config.defaults.repoName);
        if (project) {
          cachedProjectUuid = project.uuid;
          logger.info(`Resolved project: ${project.name} (${project.uuid})`);
        } else {
          logger.info(`No project found for repo "${config.defaults.repoName}" — proceeding without project_id`);
        }
      } catch (err) {
        logger.warn(`Failed to look up project for repo "${config.defaults.repoName}": ${err}`);
      }
    }

    // --- Build context data (targetUrl is the tunnel URL for localhost, original URL otherwise) ---
    const contextData: Record<string, any> = {
      targetUrl: ctx.targetUrl ?? originalUrl,
      goal: input.description,
    };
    if (cachedProjectUuid) {
      contextData.projectId = cachedProjectUuid;
    }

    // --- Build env (credentials/environment) ---
    const env: Record<string, any> = {};
    if (input.environmentId) env.environmentId = input.environmentId;
    if (input.credentialId) env.credentialId = input.credentialId;
    if (input.credentialRole) env.credentialRole = input.credentialRole;
    if (input.username) env.username = input.username;
    if (input.password) env.password = input.password;

    // --- Execute ---
    if (progressCallback) {
      await progressCallback({ progress: 3, total: TOTAL_STEPS, message: 'Queuing workflow execution...' });
    }

    const executeResponse = await client.workflows!.executeWorkflow(
      cachedTemplateUuid,
      contextData,
      Object.keys(env).length > 0 ? env : undefined
    );
    const executionUuid = executeResponse.executionUuid;
    logger.info(`Execution queued: ${executionUuid}`);

    // --- Poll ---
    // Track execution progress via state.stepsTaken from the API.
    // Setup is steps 1-3, execution maps stepsTaken into steps 4-28 (25 slots).
    let lastStepsTaken = 0;
    let lastNodeCount = 0;
    let observedMaxSteps = MAX_EXEC_STEPS;
    const finalExecution = await client.workflows!.pollExecution(executionUuid, async (exec) => {
      // Keep the tunnel alive while the workflow is actively running
      if (ctx.tunnelId) touchTunnelById(ctx.tunnelId);

      const nodeCount = exec.nodeExecutions?.length ?? 0;
      const stepsTaken = exec.state?.stepsTaken ?? 0;

      if (nodeCount !== lastNodeCount || stepsTaken !== lastStepsTaken || exec.status !== 'pending') {
        lastNodeCount = nodeCount;
        lastStepsTaken = stepsTaken;
        logger.info(`Execution status: ${exec.status}, nodes: ${nodeCount}, steps: ${stepsTaken}`);
      }

      if (progressCallback) {
        // If we see steps > our assumed max, bump our ceiling so progress never goes backwards
        if (stepsTaken > observedMaxSteps) {
          observedMaxSteps = stepsTaken + 5;
        }

        // Map stepsTaken (0..observedMaxSteps) into progress (SETUP_STEPS+1 .. TOTAL_STEPS-1)
        // Reserve the last tick for the "Complete" message
        let execProgress: number;
        if (stepsTaken > 0) {
          execProgress = SETUP_STEPS + Math.round((stepsTaken / observedMaxSteps) * (MAX_EXEC_STEPS - 1));
        } else {
          // No steps yet — show we're past setup but execution is starting
          execProgress = SETUP_STEPS + 1;
        }
        execProgress = Math.min(execProgress, TOTAL_STEPS - 1);

        let message: string;
        if (exec.status === 'running') {
          if (stepsTaken > 0) {
            message = `Agent evaluating app... (step ${stepsTaken})`;
          } else if (nodeCount === 0) {
            message = 'Browser agent starting up...';
          } else {
            message = 'Browser ready, agent navigating...';
          }
        } else {
          message = exec.status;
        }

        await progressCallback({ progress: execProgress, total: TOTAL_STEPS, message });
      }
    }, abortController.signal);

    const duration = Date.now() - startTime;

    // --- Format result ---
    const outcome = finalExecution.state?.outcome ?? finalExecution.status;
    const surferNode = finalExecution.nodeExecutions?.find(
      n => n.nodeType === 'surfer.execute_task'
    );

    // Log all node executions to diagnose what the backend returns
    logger.info('Node executions raw data', {
      nodeCount: finalExecution.nodeExecutions?.length ?? 0,
      nodes: finalExecution.nodeExecutions?.map(n => ({
        nodeId: n.nodeId,
        nodeType: n.nodeType,
        status: n.status,
        outputKeys: n.outputData ? Object.keys(n.outputData) : [],
        outputData: n.outputData,
      })),
    });

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
      await progressCallback({ progress: TOTAL_STEPS, total: TOTAL_STEPS, message: `Complete: ${outcome}` });
    }

    const content: ToolResponse['content'] = [
      { type: 'text', text: JSON.stringify(responsePayload, null, 2) },
    ];

    // Search all node outputs for screenshot/gif URLs — not just the surfer node
    const SCREENSHOT_KEYS = ['finalScreenshot', 'screenshot', 'screenshotUrl', 'screenshotUri'];
    const GIF_KEYS = ['runGif', 'gifUrl', 'gif', 'videoUrl', 'recordingUrl'];

    let screenshotUrl: string | null = null;
    let gifUrl: string | null = null;

    for (const node of finalExecution.nodeExecutions ?? []) {
      const data = node.outputData ?? {};
      if (!screenshotUrl) {
        for (const key of SCREENSHOT_KEYS) {
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
      if (screenshotUrl && gifUrl) break;
    }

    if (screenshotUrl) {
      logger.info(`Embedding screenshot: ${screenshotUrl}`);
      const img = await fetchImageAsBase64(screenshotUrl).catch(() => null);
      if (img) content.push(imageContentBlock(img.data, img.mimeType));
    }
    if (gifUrl) {
      logger.info(`Embedding GIF/video: ${gifUrl}`);
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
    // Tunnels stay alive for reuse — the 55-min auto-shutoff on TunnelManager
    // fires revokeKey when the tunnel actually stops.
    //
    // Only revoke explicitly when we provisioned a key but tunnel creation failed
    // (keyId set, ctx.tunnelId not set → key was never attached to a tunnel).
    if (keyId && !ctx.tunnelId) {
      client.revokeNgrokKey(keyId).catch(err =>
        logger.warn(`Failed to revoke unused ngrok key ${keyId}: ${err}`)
      );
    }
  }
}
