/**
 * Quick Screenshot Tool
 * Provides a simple way to capture screenshots of any URL without managing sessions.
 * Supports localhost URLs via automatic tunnel creation.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ValidatedTool, ToolContext, ProgressCallback } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { fetchImageAsBase64, imageContentBlock } from '../utils/imageUtils.js';
import { createClientService } from '../services/index.js';
import { QuickScreenshotParams, QuickScreenshotResponse, QuickScreenshotStatusResponse } from '../services/browserSessions.js';
import {
  resolveTargetUrl,
  buildContext,
  ensureTunnel,
  releaseTunnel,
  sanitizeResponseUrls,
} from '../utils/tunnelContext.js';

const logger = new Logger({ module: 'quickScreenshot' });

export const quickScreenshotInputSchema = z.object({
  url: z.string().url('Must be a valid URL').optional(),
  localPort: z.number().int().min(1).max(65535).optional(),
  type: z.enum(['VIEWPORT', 'FULL_PAGE']).optional().default('VIEWPORT'),
}).refine(d => d.url || d.localPort, {
  message: 'Provide either "url" or "localPort"',
});

export type QuickScreenshotInput = z.infer<typeof quickScreenshotInputSchema>;

async function pollForCompletion(
  browserSessionsService: any,
  taskId: string,
  pollIntervalSeconds: number,
  progressCallback?: ProgressCallback,
  logger?: any
): Promise<QuickScreenshotStatusResponse> {
  const maxAttempts = 30;
  const pollInterval = pollIntervalSeconds * 1000;
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const statusResponse = await browserSessionsService.getQuickScreenshotStatus(taskId);

      if (statusResponse.status === 'completed' || statusResponse.status === 'failed') {
        if (logger) logger.info('Screenshot polling completed', { taskId, attempts: attempts + 1, status: statusResponse.status });
        return statusResponse;
      }

      let progressPercent = 60;
      if (statusResponse.status === 'processing') progressPercent = 70;
      else if (statusResponse.status === 'capturing') progressPercent = 80;

      if (progressCallback) {
        await progressCallback({
          progress: progressPercent,
          total: 100,
          message: `Screenshot ${statusResponse.status}... (attempt ${attempts + 1}/${maxAttempts})`
        });
      }

      attempts++;
      await new Promise(resolve => setTimeout(resolve, pollInterval));

    } catch (error) {
      if (logger) logger.warn('Polling attempt failed', { taskId, attempts, error: error instanceof Error ? error.message : String(error) });
      attempts++;
      if (attempts >= maxAttempts) {
        throw new Error(`Screenshot polling failed after ${maxAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error(`Screenshot did not complete within ${maxAttempts * pollInterval / 1000} seconds`);
}

export const quickScreenshotTool: Tool = {
  name: 'quick_screenshot',
  title: 'Quick URL Screenshot',
  description: 'Take a one-shot screenshot of any public URL or local dev server. No session required, just point and shoot.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'The URL to navigate to and capture a screenshot of'
      },
      localPort: {
        type: 'number',
        description: 'Port of your local dev server (e.g. 3000, 8080). A secure tunnel is created automatically.'
      },
      type: {
        type: 'string',
        enum: ['VIEWPORT', 'FULL_PAGE'],
        default: 'VIEWPORT',
        description: 'Type of screenshot to capture - VIEWPORT for visible area only, FULL_PAGE for entire page'
      }
    },
    additionalProperties: false
  }
};

async function quickScreenshotHandler(
  input: QuickScreenshotInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<any> {
  const requestLogger = logger.child({ requestId: context.requestId });

  const originalUrl = resolveTargetUrl(input);
  let ctx = buildContext(originalUrl);

  requestLogger.info('Starting quick screenshot capture', {
    url: originalUrl,
    isLocalhost: ctx.isLocalhost,
    type: input.type,
  });

  try {
    if (progressCallback) {
      await progressCallback({ progress: 0, total: 100, message: `Initiating screenshot capture for ${originalUrl}` });
    }

    const client = await createClientService();
    const browserSessionsService = client.browserSessions;

    if (!browserSessionsService) {
      throw new Error('Browser sessions service not available');
    }

    if (progressCallback) {
      await progressCallback({ progress: 25, total: 100, message: 'Connecting to browser and navigating to URL' });
    }

    // For localhost, the quickScreenshot API returns a tunnelKey we use to open the tunnel
    const params: QuickScreenshotParams = { url: originalUrl, type: input.type };
    const response: QuickScreenshotResponse = await browserSessionsService.quickScreenshot(params);

    // Create tunnel for localhost after the backend responds with a tunnelKey
    if (ctx.isLocalhost) {
      const tunnelKey = (response as any).tunnelKey ?? (response as any).tunnel_key;
      if (tunnelKey) {
        if (progressCallback) {
          await progressCallback({ progress: 35, total: 100, message: 'Creating secure tunnel for localhost...' });
        }
        ctx = await ensureTunnel(ctx, tunnelKey, response.sessionId);
        requestLogger.info(`Tunnel ready for ${originalUrl} (id: ${response.sessionId})`);
      } else {
        requestLogger.warn('Backend did not return a tunnel key for localhost screenshot — screenshot may fail');
      }
    }

    requestLogger.info('Quick screenshot initiated', {
      taskId: response.taskId,
      sessionId: response.sessionId,
      status: response.status,
    });

    if (progressCallback) {
      await progressCallback({ progress: 50, total: 100, message: 'Waiting for screenshot to complete...' });
    }

    const completedResponse = await pollForCompletion(
      browserSessionsService,
      response.taskId,
      response.polling.pollIntervalSeconds,
      progressCallback,
      requestLogger
    );

    let downloadInfo = null;
    if (completedResponse.status === 'completed') {
      try {
        downloadInfo = await browserSessionsService.getQuickScreenshotDownload(response.taskId);
      } catch (error) {
        requestLogger.warn('Failed to get download URL', { taskId: response.taskId, error });
      }
    }

    let imageBase64: { data: string; mimeType: string } | null = null;
    if (downloadInfo?.downloadUrl) {
      imageBase64 = await fetchImageAsBase64(downloadInfo.downloadUrl);
    }

    if (progressCallback) {
      await progressCallback({ progress: 100, total: 100, message: 'Quick screenshot completed successfully' });
    }

    const responsePayload = sanitizeResponseUrls({
      success: true,
      taskId: response.taskId,
      sessionId: completedResponse.sessionId,
      screenshotActionId: completedResponse.screenshotActionId,
      url: completedResponse.url,
      screenshotType: completedResponse.screenshotType,
      status: completedResponse.status,
      message: completedResponse.message,
      downloadUrl: downloadInfo?.downloadUrl,
      sessionInfo: completedResponse.sessionInfo ?? null,
      polling: {
        statusUrl: response.polling.statusUrl,
        downloadUrlAvailableWhenComplete: response.polling.downloadUrlAvailableWhenComplete,
        pollIntervalSeconds: response.polling.pollIntervalSeconds
      },
    }, ctx);

    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
      { type: 'text', text: JSON.stringify(responsePayload, null, 2) }
    ];

    if (imageBase64) {
      content.push(imageContentBlock(imageBase64.data, imageBase64.mimeType));
    }

    return { content };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    requestLogger.error('Quick screenshot failed', { url: originalUrl, type: input.type, error: errorMessage });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: errorMessage,
          url: originalUrl,
          screenshotType: input.type,
          troubleshooting: [
            'Verify the URL is accessible and valid',
            'For localhost URLs, ensure the dev server is running on the specified port',
            'Check if the DebuggAI service is running',
            'Ensure proper API authentication is configured',
          ]
        }, null, 2)
      }],
      isError: true
    };
  } finally {
    releaseTunnel(ctx).catch(err =>
      requestLogger.warn(`Failed to release tunnel: ${err}`)
    );
  }
}

export const validatedQuickScreenshotTool: ValidatedTool = {
  name: quickScreenshotTool.name,
  description: quickScreenshotTool.description,
  inputSchema: quickScreenshotInputSchema,
  handler: quickScreenshotHandler,
};
