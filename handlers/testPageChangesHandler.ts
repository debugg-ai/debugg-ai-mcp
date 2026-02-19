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
import { DebuggAIServerClient } from '../services/index.js';
import { tunnelManager } from '../services/ngrok/tunnelManager.js';
import { extractLocalhostPort } from '../utils/urlParser.js';

const logger = new Logger({ module: 'testPageChangesHandler' });

// Cache the template UUID within a server session to avoid re-fetching
let cachedTemplateUuid: string | null = null;

function isLocalhostUrl(url: string): boolean {
  return url.includes('localhost') || url.includes('127.0.0.1');
}

/**
 * Resolve the target URL from input.
 * - If `url` is provided, use it directly.
 * - If only `localPort` is provided, construct http://localhost:{port}.
 * - Otherwise error.
 */
function resolveTargetUrl(input: TestPageChangesInput): string {
  if (input.url) return input.url;
  if (input.localPort) return `http://localhost:${input.localPort}`;
  throw new Error(
    'Provide a target URL via the "url" parameter (e.g. "https://example.com") ' +
    'or a "localPort" for a local dev server.'
  );
}

export async function testPageChangesHandler(
  input: TestPageChangesInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('check_app_in_browser', input);

  const client = new DebuggAIServerClient(config.api.key);
  await client.init();

  let tunnelId: string | undefined;
  let ngrokKeyId: string | undefined;

  try {
    const targetUrlRaw = resolveTargetUrl(input);
    const isLocalhost = isLocalhostUrl(targetUrlRaw);

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
      targetUrl: targetUrlRaw,
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

    // --- Localhost tunneling (after execute, using tunnel_key + executionUuid as subdomain) ---
    if (isLocalhost) {
      if (progressCallback) {
        await progressCallback({ progress: 3, total: 10, message: 'Creating secure tunnel for localhost...' });
      }

      const port = extractLocalhostPort(targetUrlRaw);
      if (!port) {
        throw new Error(`Could not extract port from localhost URL: ${targetUrlRaw}`);
      }

      if (!executeResponse.tunnelKey) {
        throw new Error('Backend did not return a tunnel key for localhost execution');
      }

      tunnelId = executionUuid;
      const tunnelResult = await tunnelManager.processUrl(targetUrlRaw, executeResponse.tunnelKey, tunnelId);
      logger.info(`Tunnel ready: ${tunnelResult.url}`);
    }

    // --- Poll ---
    let lastSteps = 0;
    const finalExecution = await client.workflows!.pollExecution(executionUuid, async (exec) => {
      const steps = exec.state?.stepsTaken ?? 0;
      if (steps !== lastSteps || exec.status !== 'pending') {
        lastSteps = steps;
        logger.info(`Execution status: ${exec.status}, steps: ${steps}`);
      }
      if (progressCallback) {
        const progress = Math.min(3 + steps, 9);
        await progressCallback({
          progress,
          total: 10,
          message: `${exec.status}: ${steps} step${steps !== 1 ? 's' : ''} taken`,
        }).catch(() => {});
      }
    });

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
      targetUrl: targetUrlRaw,
      executionId: executionUuid,
      durationMs: finalExecution.durationMs ?? duration,
    };

    if (finalExecution.state?.error) {
      responsePayload.agentError = finalExecution.state.error;
    }
    if (finalExecution.errorMessage) {
      responsePayload.errorMessage = finalExecution.errorMessage;
    }
    if (finalExecution.errorInfo?.failedNodeId) {
      responsePayload.failedNode = finalExecution.errorInfo.failedNodeId;
    }
    if (executeResponse.resolvedEnvironmentId) {
      responsePayload.resolvedEnvironmentId = executeResponse.resolvedEnvironmentId;
    }
    if (executeResponse.resolvedCredentialId) {
      responsePayload.resolvedCredentialId = executeResponse.resolvedCredentialId;
    }
    if (surferNode?.outputData) {
      responsePayload.surferOutput = surferNode.outputData;
    }

    logger.toolComplete('check_app_in_browser', duration);

    if (progressCallback) {
      await progressCallback({ progress: 10, total: 10, message: `Complete: ${outcome}` });
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responsePayload, null, 2),
      }],
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('check_app_in_browser', error as Error, duration);

    // Invalidate cached template UUID on auth/not-found errors
    if (error instanceof Error && (error.message.includes('not found') || error.message.includes('401'))) {
      cachedTemplateUuid = null;
    }

    throw handleExternalServiceError(error, 'DebuggAI', 'test execution');
  } finally {
    // Revoke the short-lived ngrok key
    if (ngrokKeyId) {
      client.revokeNgrokKey(ngrokKeyId).catch(err =>
        logger.warn(`Failed to revoke ngrok key ${ngrokKeyId}: ${err}`)
      );
    }
    // Clean up tunnel if we created one
    if (tunnelId) {
      tunnelManager.stopTunnel(tunnelId).catch(err =>
        logger.warn(`Failed to stop tunnel ${tunnelId}: ${err}`)
      );
    }
  }
}
