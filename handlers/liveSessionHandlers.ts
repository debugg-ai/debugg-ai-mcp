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
import { DebuggAIServerClient } from '../services/index.js';
import { tunnelManager } from '../services/ngrok/tunnelManager.js';
import { extractLocalhostPort } from '../utils/urlParser.js';

const logger = new Logger({ module: 'liveSessionHandlers' });

// Create service client for browser sessions
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
  logger.toolStart('debugg_ai_start_live_session', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 4, message: 'Initializing live session...' });
    }

    // Get the service client
    const client = await getServiceClient();
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 4, message: 'Configuring browser monitoring...' });
    }

    // Process URL - detect if it needs tunneling or is already tunneled
    if (progressCallback) {
      await progressCallback({ progress: 2.5, total: 4, message: 'Processing URL for remote browser access...' });
    }
    
    // Detect URL type and extract metadata
    const isLocalhost = input.url.includes('localhost') || input.url.includes('127.0.0.1') || input.url.includes('::1');
    const isTunneled = tunnelManager.isTunnelUrl(input.url);
    const tunnelId = isTunneled ? tunnelManager.extractTunnelId(input.url) : undefined;
    
    const tunnelResult = {
      url: input.url, // Pass original URL, let backend handle tunneling
      isLocalhost: isLocalhost && !isTunneled,
      tunnelId
    };

    // Prepare session parameters
    const sessionParams = {
      url: tunnelResult.url,
      originalUrl: input.url,
      localPort: input.localPort || extractLocalhostPort(input.url),
      sessionName: input.sessionName || `Session ${new Date().toISOString()}`,
      monitorConsole: input.monitorConsole ?? true,
      monitorNetwork: input.monitorNetwork ?? true,
      takeScreenshots: input.takeScreenshots ?? false,
      screenshotInterval: input.screenshotInterval ?? 10,
      isLocalhost: tunnelResult.isLocalhost,
      tunnelId: tunnelResult.tunnelId
    };

    if (progressCallback) {
      await progressCallback({ progress: 3, total: 4, message: 'Starting browser session...' });
    }

    // Start the session via API
    const session = await client.browserSessions.startSession(sessionParams);

    if (progressCallback) {
      await progressCallback({ progress: 4, total: 4, message: 'Live session started successfully' });
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      session: session
    };

    logger.toolComplete('debugg_ai_start_live_session', duration);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('debugg_ai_start_live_session', error as Error, duration);
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
  logger.toolStart('debugg_ai_stop_live_session', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 3, message: 'Stopping live session...' });
    }

    // Get the service client
    const client = await getServiceClient();
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    // Use provided session ID or throw error if none provided
    if (!input.sessionId) {
      throw new Error('No session ID provided and no current session active');
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 3, message: 'Cleaning up session resources...' });
    }

    // Stop the session via API
    const result = await client.browserSessions.stopSession(input.sessionId);
    
    // Clean up any associated tunnels
    if (result.session && 'tunnelId' in result.session && result.session.tunnelId) {
      try {
        await tunnelManager.stopTunnel(result.session.tunnelId as string);
      } catch (error) {
        logger.warn(`Failed to cleanup tunnel ${result.session.tunnelId}:`, error);
      }
    }

    if (progressCallback) {
      await progressCallback({ progress: 3, total: 3, message: 'Session stopped successfully' });
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      session: result.session,
      summary: result.summary
    };

    logger.toolComplete('debugg_ai_stop_live_session', duration);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('debugg_ai_stop_live_session', error as Error, duration);
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
  logger.toolStart('debugg_ai_get_live_session_status', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 2, message: 'Retrieving session status...' });
    }

    // Get the service client
    const client = await getServiceClient();
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    let responseContent;

    if (input.sessionId) {
      // Get specific session status
      const result = await client.browserSessions.getSessionStatus(input.sessionId);
      responseContent = {
        success: true,
        session: result.session,
        stats: result.stats
      };
    } else {
      // List active sessions
      const sessions = await client.browserSessions.listSessions({ status: 'active' });
      responseContent = {
        success: true,
        currentSession: sessions.results.length > 0 ? sessions.results[0] : null,
        activeSessions: sessions.results
      };
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 2, message: 'Status retrieved successfully' });
    }

    const duration = Date.now() - startTime;
    logger.toolComplete('debugg_ai_get_live_session_status', duration);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('debugg_ai_get_live_session_status', error as Error, duration);
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
  logger.toolStart('debugg_ai_get_live_session_logs', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 2, message: 'Retrieving session logs...' });
    }

    // Get the service client
    const client = await getServiceClient();
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    if (!input.sessionId) {
      throw new Error('Session ID is required to retrieve logs');
    }

    // Prepare log query parameters
    const logParams = {
      logType: input.logType || 'all',
      since: input.since,
      limit: input.limit || 100
    };

    // Get logs via API
    const result = await client.browserSessions.getSessionLogs(input.sessionId, logParams);

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 2, message: 'Logs retrieved successfully' });
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      ...result
    };

    logger.toolComplete('debugg_ai_get_live_session_logs', duration);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('debugg_ai_get_live_session_logs', error as Error, duration);
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
  logger.toolStart('debugg_ai_get_live_session_screenshot', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 3, message: 'Preparing screenshot capture...' });
    }

    // Get the service client
    const client = await getServiceClient();
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    if (!input.sessionId) {
      throw new Error('Session ID is required to capture screenshot');
    }

    // First check if session is active
    const statusResult = await client.browserSessions.getSessionStatus(input.sessionId);
    if (statusResult.session.status !== 'active') {
      throw new Error('Cannot take screenshot: session is stopped');
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 3, message: 'Capturing screenshot...' });
    }

    // Prepare screenshot parameters
    const screenshotParams = {
      fullPage: input.fullPage ?? false,
      quality: input.quality ?? 90,
      format: input.format ?? 'png'
    };

    // Capture screenshot via API
    const result = await client.browserSessions.captureScreenshot(input.sessionId, screenshotParams);

    if (progressCallback) {
      await progressCallback({ progress: 3, total: 3, message: 'Screenshot captured successfully' });
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      ...result
    };

    logger.toolComplete('debugg_ai_get_live_session_screenshot', duration);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('debugg_ai_get_live_session_screenshot', error as Error, duration);
    throw handleExternalServiceError(error, 'Live Session', 'screenshot capture');
  }
}