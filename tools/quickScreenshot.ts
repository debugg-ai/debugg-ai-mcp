/**
 * Quick Screenshot Tool
 * Provides a simple way to capture screenshots of any URL without managing sessions
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ValidatedTool, ToolContext, ProgressCallback } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { fetchImageAsBase64, imageContentBlock } from '../utils/imageUtils.js';
import { createClientService } from '../services/index.js';
import { QuickScreenshotParams, QuickScreenshotResponse, QuickScreenshotStatusResponse } from '../services/browserSessions.js';

const logger = new Logger({ module: 'quickScreenshot' });

/**
 * Input validation schema
 */
export const quickScreenshotInputSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  type: z.enum(['VIEWPORT', 'FULL_PAGE']).optional().default('VIEWPORT'),
});

export type QuickScreenshotInput = z.infer<typeof quickScreenshotInputSchema>;

/**
 * Poll for screenshot completion using task ID
 */
async function pollForCompletion(
  browserSessionsService: any,
  taskId: string,
  pollIntervalSeconds: number,
  progressCallback?: ProgressCallback,
  logger?: any
): Promise<QuickScreenshotStatusResponse> {
  const maxAttempts = 30; // 30 attempts * poll interval = max wait time
  const pollInterval = pollIntervalSeconds * 1000; // convert to milliseconds
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const statusResponse = await browserSessionsService.getQuickScreenshotStatus(taskId);
      
      // Check if task is completed
      if (statusResponse.status === 'completed' || statusResponse.status === 'failed') {
        if (logger) {
          logger.info('Screenshot polling completed', {
            taskId,
            attempts: attempts + 1,
            status: statusResponse.status
          });
        }
        return statusResponse;
      }

      // Update progress based on status
      let progressPercent = 60; // Start at 60% for polling
      if (statusResponse.status === 'processing') {
        progressPercent = 70;
      } else if (statusResponse.status === 'capturing') {
        progressPercent = 80;
      }

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
      if (logger) {
        logger.warn('Polling attempt failed', { taskId, attempts, error: error instanceof Error ? error.message : String(error) });
      }
      attempts++;
      if (attempts >= maxAttempts) {
        throw new Error(`Screenshot polling failed after ${maxAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error(`Screenshot did not complete within ${maxAttempts * pollInterval / 1000} seconds`);
}

/**
 * Quick Screenshot MCP Tool Definition
 */
export const quickScreenshotTool: Tool = {
  name: 'quick_screenshot',
  title: 'Quick URL Screenshot',
  description: 'Take a one-shot screenshot of any public URL. No session required, just point and shoot.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'The URL to navigate to and capture a screenshot of'
      },
      type: {
        type: 'string',
        enum: ['VIEWPORT', 'FULL_PAGE'],
        default: 'VIEWPORT',
        description: 'Type of screenshot to capture - VIEWPORT for visible area only, FULL_PAGE for entire page'
      }
    },
    required: ['url'],
    additionalProperties: false
  }
};

/**
 * Quick Screenshot Tool Handler
 */
async function quickScreenshotHandler(
  input: QuickScreenshotInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<any> {
  const requestLogger = logger.child({ requestId: context.requestId });
  
  requestLogger.info('Starting quick screenshot capture', {
    url: input.url,
    type: input.type,
    timestamp: context.timestamp.toISOString()
  });

  try {
    // Report progress - starting screenshot
    if (progressCallback) {
      await progressCallback({
        progress: 0,
        total: 100,
        message: `Initiating screenshot capture for ${input.url}`
      });
    }

    // Create service client
    const client = await createClientService();
    const browserSessionsService = client.browserSessions;
    
    if (!browserSessionsService) {
      throw new Error('Browser sessions service not available');
    }

    // Prepare parameters
    const params: QuickScreenshotParams = {
      url: input.url,
      type: input.type
    };

    // Report progress - calling API
    if (progressCallback) {
      await progressCallback({
        progress: 25,
        total: 100,
        message: 'Connecting to browser and navigating to URL'
      });
    }

    // Call quick screenshot API
    const response: QuickScreenshotResponse = await browserSessionsService.quickScreenshot(params);

    requestLogger.info('Quick screenshot initiated successfully', {
      taskId: response.taskId,
      sessionId: response.sessionId,
      url: response.url,
      screenshotType: response.screenshotType,
      status: response.status,
      sessionStatus: response.sessionInfo.status
    });

    // Report progress - waiting for completion
    if (progressCallback) {
      await progressCallback({
        progress: 50,
        total: 100,
        message: 'Waiting for screenshot to complete...'
      });
    }

    // Poll for completion using task ID
    const completedResponse = await pollForCompletion(
      browserSessionsService,
      response.taskId,
      response.polling.pollIntervalSeconds,
      progressCallback,
      requestLogger
    );

    // Get download URL if completed successfully
    let downloadInfo = null;
    if (completedResponse.status === 'completed') {
      try {
        downloadInfo = await browserSessionsService.getQuickScreenshotDownload(response.taskId);
      } catch (error) {
        requestLogger.warn('Failed to get download URL', { taskId: response.taskId, error });
      }
    }

    // Fetch the image from the download URL so we can embed it directly
    let imageBase64: { data: string; mimeType: string } | null = null;
    if (downloadInfo?.downloadUrl) {
      imageBase64 = await fetchImageAsBase64(downloadInfo.downloadUrl);
    }

    // Report completion
    if (progressCallback) {
      await progressCallback({
        progress: 100,
        total: 100,
        message: 'Quick screenshot completed successfully'
      });
    }

    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          taskId: response.taskId,
          sessionId: completedResponse.sessionId,
          screenshotActionId: completedResponse.screenshotActionId,
          url: completedResponse.url,
          screenshotType: completedResponse.screenshotType,
          status: completedResponse.status,
          message: completedResponse.message,
          downloadUrl: downloadInfo?.downloadUrl,
          sessionInfo: {
            sessionName: completedResponse.sessionInfo.sessionName,
            status: completedResponse.sessionInfo.status,
            vncUrl: completedResponse.sessionInfo.vncUrl,
            createdAt: completedResponse.sessionInfo.createdAt
          },
          polling: {
            statusUrl: response.polling.statusUrl,
            downloadUrlAvailableWhenComplete: response.polling.downloadUrlAvailableWhenComplete,
            pollIntervalSeconds: response.polling.pollIntervalSeconds
          },
        }, null, 2)
      }
    ];

    if (imageBase64) {
      content.push(imageContentBlock(imageBase64.data, imageBase64.mimeType));
    }

    return { content };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    requestLogger.error('Quick screenshot failed', {
      url: input.url,
      type: input.type,
      error: errorMessage
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: errorMessage,
            url: input.url,
            screenshotType: input.type,
            troubleshooting: [
              'Verify the URL is accessible and valid',
              'Check if the DebuggAI service is running',
              'Ensure proper API authentication is configured',
              'Try again with a simpler URL if the target site has complex authentication'
            ]
          }, null, 2)
        }
      ],
      isError: true
    };
  }
}

/**
 * Validated Quick Screenshot Tool
 */
export const validatedQuickScreenshotTool: ValidatedTool = {
  name: quickScreenshotTool.name,
  description: quickScreenshotTool.description,
  inputSchema: quickScreenshotInputSchema,
  handler: quickScreenshotHandler,
};