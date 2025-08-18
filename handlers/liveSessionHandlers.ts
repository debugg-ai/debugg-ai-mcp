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
    if (!client) {
      throw new Error('Service client not available');
    }
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
    
    logger.info(`Processing URL for tunnel: ${input.url}, has API key: ${!!config.api.key}`);
    
    // Check if we need to create a tunnel (localhost URL)
    const isLocalhost = input.url.includes('localhost') || input.url.includes('127.0.0.1');
    let sessionUrl = input.url;
    let tunnelId: string | undefined;
    
    if (isLocalhost) {
      // Generate a UUID for the tunnel subdomain
      const { v4: uuidv4 } = await import('uuid');
      tunnelId = uuidv4();
      
      // Create the tunneled URL that we'll send to the backend
      const port = extractLocalhostPort(input.url);
      const url = new URL(input.url);
      sessionUrl = `https://${tunnelId}.ngrok.debugg.ai${url.pathname}${url.search}${url.hash}`;
      
      logger.info(`Generated tunnel URL for backend: ${sessionUrl} (tunnelId: ${tunnelId})`);
    }
    
    // Start the session with the tunneled URL (or original URL if not localhost)
    const sessionParams = {
      url: sessionUrl,
      originalUrl: input.url,
      localPort: input.localPort || extractLocalhostPort(input.url),
      sessionName: input.sessionName || `Session ${new Date().toISOString()}`,
      monitorConsole: input.monitorConsole ?? true,
      monitorNetwork: input.monitorNetwork ?? true,
      takeScreenshots: input.takeScreenshots ?? false,
      screenshotInterval: input.screenshotInterval ?? 10,
      isLocalhost: isLocalhost,
      tunnelId: tunnelId
    };

    // Start the session via API to get tunnelKey
    const session = await client.browserSessions.startSession(sessionParams);
    
    if (!session) {
      throw new Error('Failed to start browser session: No session returned');
    }

    // If we need a tunnel, create it now using the tunnelKey from the backend
    if (isLocalhost && tunnelId) {
      const tunnelAuthToken = session.tunnelKey;
      if (!tunnelAuthToken) {
        throw new Error('No tunnel key provided by backend - tunnels not available for localhost URLs');
      }

      logger.info(`Creating tunnel with backend-provided key for ${input.url} -> ${sessionUrl}`);
      
      // Create the tunnel using the original localhost URL and the generated tunnel ID
      const port = extractLocalhostPort(input.url);
      if (!port) {
        throw new Error(`Could not extract port from localhost URL: ${input.url}`);
      }
      
      // Use tunnel manager to create the tunnel with the specific tunnel ID
      const tunnelResult = await tunnelManager.processUrl(input.url, tunnelAuthToken, tunnelId);
      
      logger.info(`Tunnel created: ${tunnelResult.url} (ID: ${tunnelResult.tunnelId})`);
      
      // Touch the tunnel to reset its timer
      if (tunnelResult.tunnelId) {
        tunnelManager.touchTunnel(tunnelResult.tunnelId);
      }
    }
    
    logger.info(`Session created successfully: ${session.sessionId}`);
    if (isLocalhost && tunnelId) {
      logger.info(`Tunnel will be available at: https://${tunnelId}.ngrok.debugg.ai`);
    }

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
    if (!client) {
      throw new Error('Service client not available');
    }
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
    if (!client) {
      throw new Error('Service client not available');
    }
    if (!client.browserSessions) {
      throw new Error('Browser sessions service not available');
    }

    let responseContent;

    if (input.sessionId) {
      // Get specific session status
      const result = await client.browserSessions.getSessionStatus(input.sessionId);
      
      // Reset tunnel timer if this session has an associated tunnel
      if (result.session && 'tunnelId' in result.session && result.session.tunnelId) {
        tunnelManager.touchTunnel(result.session.tunnelId as string);
      }
      
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
    if (!client) {
      throw new Error('Service client not available');
    }
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
    
    // Reset tunnel timer if this session has an associated tunnel
    if (result && 'session' in result && result.session && 'tunnelId' in result.session && result.session.tunnelId) {
      tunnelManager.touchTunnel(result.session.tunnelId as string);
    }

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
    if (!client) {
      throw new Error('Service client not available');
    }
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
    
    // Reset tunnel timer if this session has an associated tunnel
    // First get session info to check for tunnel
    try {
      const sessionStatus = await client.browserSessions.getSessionStatus(input.sessionId);
      if (sessionStatus.session && 'tunnelId' in sessionStatus.session && sessionStatus.session.tunnelId) {
        tunnelManager.touchTunnel(sessionStatus.session.tunnelId as string);
      }
    } catch (error) {
      // Don't fail the screenshot if we can't get session info
      logger.warn(`Could not get session info to reset tunnel timer: ${error}`);
    }

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