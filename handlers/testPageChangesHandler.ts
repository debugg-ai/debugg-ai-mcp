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
import { detectRepoName } from '../utils/gitContext.js';
import { tunnelManager } from '../services/ngrok/tunnelManager.js';

const logger = new Logger({ module: 'testPageChangesHandler' });

// Cache the template UUID and project UUIDs within a server session to avoid re-fetching
let cachedTemplateUuid: string | null = null;
const projectUuidCache = new Map<string, string>();

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
    // Use explicit repoName if provided, otherwise auto-detect from git remote
    const repoName = input.repoName || detectRepoName();
    let projectUuid: string | undefined;
    if (repoName) {
      projectUuid = projectUuidCache.get(repoName);
      if (!projectUuid) {
        try {
          const project = await client.findProjectByRepoName(repoName);
          if (project) {
            projectUuid = project.uuid;
            projectUuidCache.set(repoName, projectUuid);
            logger.info(`Resolved project: ${project.name} (${project.uuid})`);
          } else {
            logger.info(`No project found for repo "${repoName}" — proceeding without project_id`);
          }
        } catch (err) {
          logger.warn(`Failed to look up project for repo "${repoName}": ${err}`);
        }
      }
    }

    // --- Build context data (camelCase here — axiosTransport auto-converts to snake_case) ---
    const contextData: Record<string, any> = {
      targetUrl: ctx.targetUrl ?? originalUrl,
      question: input.description,
    };
    if (projectUuid) {
      contextData.projectId = projectUuid;
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

    const executeResponse = await client.workflows!.executeWorkflow(
      cachedTemplateUuid,
      contextData,
      Object.keys(env).length > 0 ? env : undefined
    );
    const executionUuid = executeResponse.executionUuid;
    logger.info(`Execution queued: ${executionUuid}`);

    // --- Poll ---
    // Progress phases:
    //   1-3:   MCP setup (tunnel, template, queue) — already sent above
    //   4-6:   Backend setup (trigger, browser.setup, subworkflow starting)
    //   7-27:  Agent steps (mapped from state.stepsTaken)
    //   28:    Complete
    const BACKEND_SETUP_END = 6;
    let lastStepsTaken = 0;
    let observedMaxSteps = MAX_EXEC_STEPS;
    const finalExecution = await client.workflows!.pollExecution(executionUuid, async (exec) => {
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

    const duration = Date.now() - startTime;

    // --- Format result ---
    const outcome = finalExecution.state?.outcome ?? finalExecution.status;
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

    const responsePayload: Record<string, any> = {
      outcome,
      success: finalExecution.state?.success ?? subworkflowNode?.outputData?.success ?? false,
      status: finalExecution.status,
      stepsTaken: finalExecution.state?.stepsTaken ?? subworkflowNode?.outputData?.stepsTaken ?? actionTrace.length,
      targetUrl: originalUrl,
      executionId: executionUuid,
      durationMs: finalExecution.durationMs ?? duration,
    };

    if (actionTrace.length > 0) responsePayload.actionTrace = actionTrace;
    if (evaluation) responsePayload.evaluation = evaluation;
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

    // Screenshot: check for already-base64 field first (subworkflow.run), then URL-based fields
    const SCREENSHOT_URL_KEYS = ['finalScreenshot', 'screenshot', 'screenshotUrl', 'screenshotUri'];
    const GIF_KEYS = ['runGif', 'gifUrl', 'gif', 'videoUrl', 'recordingUrl'];

    let screenshotEmbedded = false;
    let gifUrl: string | null = null;

    // subworkflow.run carries screenshotB64 directly — no fetch needed
    const screenshotB64 = subworkflowNode?.outputData?.screenshotB64;
    if (typeof screenshotB64 === 'string' && screenshotB64) {
      logger.info('Embedding inline base64 screenshot from subworkflow.run');
      content.push(imageContentBlock(screenshotB64, 'image/png'));
      screenshotEmbedded = true;
    }

    let screenshotUrl: string | null = null;
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
    // Always tear down the tunnel when the request completes.
    if (ctx.tunnelId) {
      tunnelManager.stopTunnel(ctx.tunnelId).catch(err =>
        logger.warn(`Failed to stop tunnel ${ctx.tunnelId}: ${err}`)
      );
    } else if (keyId) {
      // Provisioned a key but tunnel creation failed — revoke the orphaned key.
      client.revokeNgrokKey(keyId).catch(err =>
        logger.warn(`Failed to revoke unused ngrok key ${keyId}: ${err}`)
      );
    }
  }
}
