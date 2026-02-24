/**
 * Live Session Handlers
 * Handlers for managing live browser sessions with real-time monitoring
 */

import {
  StartLiveSessionInput,
  StopLiveSessionInput,
  GetLiveSessionStatusInput,
  GetLiveSessionLogsInput,
  GetLiveSessionScreenshotInput,
  ToolResponse,
  ToolContext,
  ProgressCallback
} from '../types/index.js';
import { config } from '../config/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { imageContentBlock } from '../utils/imageUtils.js';
import { DebuggAIServerClient } from '../services/index.js';
import { tunnelManager } from '../services/ngrok/tunnelManager.js';
import {
  resolveTargetUrl,
  buildContext,
  ensureTunnel,
  sanitizeResponseUrls,
} from '../utils/tunnelContext.js';

const logger = new Logger({ module: 'liveSessionHandlers' });

let serviceClient: DebuggAIServerClient | null = null;

async function getServiceClient(): Promise<DebuggAIServerClient> {
  if (!serviceClient) {
    serviceClient = new DebuggAIServerClient(config.api.key);
    await serviceClient.init();
  }
  return serviceClient;
}

/**
 * Handler for starting a live browser session
 */
export async function startLiveSessionHandler(
  input: StartLiveSessionInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('start_live_session', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 4, message: 'Initializing live session...' });
    }

    const client = await getServiceClient();
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    // Resolve and classify the target URL using the shared context
    const originalUrl = resolveTargetUrl(input);
    let ctx = buildContext(originalUrl);

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 4, message: 'Starting browser session...' });
    }

    // Send the original URL to the backend. For localhost sessions the backend
    // returns a tunnelKey; we create the actual tunnel AFTER using the session ID
    // as the ngrok subdomain (same pattern as the workflow handler, no race condition).
    const sessionParams = {
      url: originalUrl,
      sessionName: input.sessionName || `Session ${new Date().toISOString()}`,
      monitorConsole: input.monitorConsole ?? true,
      monitorNetwork: input.monitorNetwork ?? true,
      takeScreenshots: input.takeScreenshots ?? false,
      screenshotInterval: input.screenshotInterval ?? 10,
      isLocalhost: ctx.isLocalhost,
      localPort: input.localPort,
    };

    const session = await client.browserSessions.startSession(sessionParams);
    if (!session) {
      throw new Error('Failed to start browser session: no session returned');
    }

    // Create the tunnel after the backend responds with a tunnelKey.
    // The session ID is used as the ngrok subdomain so the backend can infer
    // the tunnel URL as https://{sessionId}.ngrok.debugg.ai.
    if (ctx.isLocalhost) {
      if (progressCallback) {
        await progressCallback({ progress: 3, total: 4, message: 'Creating secure tunnel for localhost...' });
      }

      if (!session.tunnelKey) {
        throw new Error('Backend did not return a tunnel key for localhost session');
      }

      try {
        ctx = await ensureTunnel(ctx, session.tunnelKey, session.sessionId);
        logger.info(`Tunnel ready for ${originalUrl} (id: ${ctx.tunnelId})`);
      } catch (tunnelErr) {
        // Tunnel creation failed — stop the backend session so it isn't stranded
        client.browserSessions!.stopSession(session.sessionId).catch(() => {});
        throw tunnelErr;
      }
    }

    logger.info(`Session created: ${session.sessionId}`);

    if (progressCallback) {
      await progressCallback({ progress: 4, total: 4, message: 'Live session started successfully' });
    }

    const duration = Date.now() - startTime;
    logger.toolComplete('start_live_session', duration);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: true, session: sanitizeResponseUrls(session, ctx) }, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('start_live_session', error as Error, duration);
    throw handleExternalServiceError(error, 'Live Session', 'session creation');
  }
}

/**
 * Handler for stopping a live browser session
 */
export async function stopLiveSessionHandler(
  input: StopLiveSessionInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('stop_live_session', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 3, message: 'Stopping live session...' });
    }

    const client = await getServiceClient();
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    if (!input.sessionId) {
      throw new Error('No session ID provided');
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 3, message: 'Cleaning up session resources...' });
    }

    const result = await client.browserSessions.stopSession(input.sessionId);

    // Clean up the tunnel keyed on sessionId (if one was created for this session)
    tunnelManager.stopTunnel(input.sessionId).catch(err =>
      logger.warn(`Failed to cleanup tunnel for session ${input.sessionId}: ${err}`)
    );

    if (progressCallback) {
      await progressCallback({ progress: 3, total: 3, message: 'Session stopped successfully' });
    }

    const duration = Date.now() - startTime;
    logger.toolComplete('stop_live_session', duration);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: true, session: result.session, summary: result.summary }, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('stop_live_session', error as Error, duration);
    throw handleExternalServiceError(error, 'Live Session', 'session termination');
  }
}

/**
 * Handler for getting live session status
 */
export async function getLiveSessionStatusHandler(
  input: GetLiveSessionStatusInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('get_live_session_status', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 2, message: 'Retrieving session status...' });
    }

    const client = await getServiceClient();
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    let responseContent;

    if (input.sessionId) {
      const result = await client.browserSessions.getSessionStatus(input.sessionId);
      tunnelManager.touchTunnel(input.sessionId);
      responseContent = { success: true, session: result.session, stats: result.stats };
    } else {
      const sessions = await client.browserSessions.listSessions({ status: 'active' });
      responseContent = {
        success: true,
        currentSession: sessions.results.length > 0 ? sessions.results[0] : null,
        activeSessions: sessions.results,
        message: sessions.results.length === 0
          ? 'No active sessions found'
          : `Found ${sessions.results.length} active session(s)`
      };
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 2, message: 'Status retrieved successfully' });
    }

    const duration = Date.now() - startTime;
    logger.toolComplete('get_live_session_status', duration);

    return {
      content: [{ type: 'text', text: JSON.stringify(responseContent, null, 2) }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('get_live_session_status', error as Error, duration);
    throw handleExternalServiceError(error, 'Live Session', 'status retrieval');
  }
}

/**
 * Handler for getting live session logs
 */
export async function getLiveSessionLogsHandler(
  input: GetLiveSessionLogsInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('get_live_session_logs', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 2, message: 'Retrieving session logs...' });
    }

    const client = await getServiceClient();
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    if (!input.sessionId) {
      throw new Error('Session ID is required to retrieve logs');
    }

    const result = await client.browserSessions.getSessionLogs(input.sessionId, {
      logType: input.logType || 'all',
      since: input.since,
      limit: input.limit || 100
    });

    tunnelManager.touchTunnel(input.sessionId);

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 2, message: 'Logs retrieved successfully' });
    }

    const duration = Date.now() - startTime;
    logger.toolComplete('get_live_session_logs', duration);

    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('get_live_session_logs', error as Error, duration);
    throw handleExternalServiceError(error, 'Live Session', 'log retrieval');
  }
}

/**
 * Handler for capturing live session screenshots
 */
export async function getLiveSessionScreenshotHandler(
  input: GetLiveSessionScreenshotInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('get_live_session_screenshot', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 3, message: 'Preparing screenshot capture...' });
    }

    const client = await getServiceClient();
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    if (!input.sessionId) {
      throw new Error('Session ID is required to capture screenshot');
    }

    const statusResult = await client.browserSessions.getSessionStatus(input.sessionId);
    if (statusResult.session.status.toLowerCase() !== 'active') {
      throw new Error('Cannot take screenshot: session is not active');
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 3, message: 'Capturing screenshot...' });
    }

    const result = await client.browserSessions.captureScreenshot(input.sessionId, {
      fullPage: input.fullPage ?? false,
      quality: input.quality ?? 90,
      format: input.format ?? 'png'
    });

    tunnelManager.touchTunnel(input.sessionId);

    if (progressCallback) {
      await progressCallback({ progress: 3, total: 3, message: 'Screenshot captured successfully' });
    }

    const duration = Date.now() - startTime;
    logger.toolComplete('get_live_session_screenshot', duration);

    const content: ToolResponse['content'] = [
      { type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) },
    ];

    const screenshot = result.screenshot as any;
    if (screenshot?.data) {
      const mimeType = screenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      content.push(imageContentBlock(screenshot.data, mimeType));
    }

    return { content };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('get_live_session_screenshot', error as Error, duration);
    throw handleExternalServiceError(error, 'Live Session', 'screenshot capture');
  }
}
