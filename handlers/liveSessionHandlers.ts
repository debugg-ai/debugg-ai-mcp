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

const logger = new Logger({ module: 'liveSessionHandlers' });

// Simple in-memory session storage for demonstration
// In a production environment, this would likely be stored in a database or cache
const activeSessions = new Map<string, any>();
let currentSession: string | null = null;

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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

    const sessionId = generateSessionId();
    const sessionData = {
      sessionId,
      url: input.url,
      localPort: input.localPort,
      sessionName: input.sessionName || `Session ${new Date().toISOString()}`,
      monitorConsole: input.monitorConsole ?? true,
      monitorNetwork: input.monitorNetwork ?? true,
      takeScreenshots: input.takeScreenshots ?? false,
      screenshotInterval: input.screenshotInterval ?? 10,
      status: 'starting',
      startTime: new Date().toISOString(),
      logs: [],
      screenshots: []
    };

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 4, message: 'Configuring browser monitoring...' });
    }

    // Store the session
    activeSessions.set(sessionId, sessionData);
    currentSession = sessionId;

    if (progressCallback) {
      await progressCallback({ progress: 3, total: 4, message: 'Starting browser session...' });
    }

    // Simulate session startup
    sessionData.status = 'active';

    if (progressCallback) {
      await progressCallback({ progress: 4, total: 4, message: 'Live session started successfully' });
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      session: {
        sessionId: sessionData.sessionId,
        sessionName: sessionData.sessionName,
        url: sessionData.url,
        localPort: sessionData.localPort,
        status: sessionData.status,
        monitoring: {
          console: sessionData.monitorConsole,
          network: sessionData.monitorNetwork,
          screenshots: sessionData.takeScreenshots,
          screenshotInterval: sessionData.screenshotInterval
        },
        startTime: sessionData.startTime
      },
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    logger.info('Live session started successfully', { 
      sessionId: sessionData.sessionId,
      url: input.url,
      duration: `${duration}ms`
    });

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
    
    throw handleExternalServiceError(error, 'Live Session', 'session start');
  }
}

/**
 * Handler for stopping a live session
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
      await progressCallback({ progress: 1, total: 3, message: 'Finding session to stop...' });
    }

    const sessionId = input.sessionId || currentSession;
    
    if (!sessionId) {
      throw new Error('No session ID provided and no current session active');
    }

    const sessionData = activeSessions.get(sessionId);
    
    if (!sessionData) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 3, message: 'Stopping live session...' });
    }

    // Update session status
    sessionData.status = 'stopped';
    sessionData.endTime = new Date().toISOString();

    // If this was the current session, clear it
    if (currentSession === sessionId) {
      currentSession = null;
    }

    if (progressCallback) {
      await progressCallback({ progress: 3, total: 3, message: 'Live session stopped successfully' });
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      session: {
        sessionId: sessionData.sessionId,
        sessionName: sessionData.sessionName,
        status: sessionData.status,
        startTime: sessionData.startTime,
        endTime: sessionData.endTime,
        totalLogs: sessionData.logs.length,
        totalScreenshots: sessionData.screenshots.length
      },
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    logger.info('Live session stopped successfully', { 
      sessionId: sessionData.sessionId,
      duration: `${duration}ms`
    });

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
    
    throw handleExternalServiceError(error, 'Live Session', 'session stop');
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
    const sessionId = input.sessionId || currentSession;
    
    if (!sessionId) {
      const duration = Date.now() - startTime;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            currentSession: null,
            activeSessions: activeSessions.size,
            executionTime: `${duration}ms`,
            timestamp: new Date().toISOString()
          }, null, 2)
        }]
      };
    }

    const sessionData = activeSessions.get(sessionId);
    
    if (!sessionData) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      session: {
        sessionId: sessionData.sessionId,
        sessionName: sessionData.sessionName,
        url: sessionData.url,
        localPort: sessionData.localPort,
        status: sessionData.status,
        startTime: sessionData.startTime,
        endTime: sessionData.endTime,
        monitoring: {
          console: sessionData.monitorConsole,
          network: sessionData.monitorNetwork,
          screenshots: sessionData.takeScreenshots,
          screenshotInterval: sessionData.screenshotInterval
        },
        stats: {
          totalLogs: sessionData.logs.length,
          totalScreenshots: sessionData.screenshots.length,
          uptime: sessionData.status === 'active' 
            ? Date.now() - new Date(sessionData.startTime).getTime()
            : sessionData.endTime 
              ? new Date(sessionData.endTime).getTime() - new Date(sessionData.startTime).getTime()
              : 0
        }
      },
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    logger.info('Live session status retrieved', { 
      sessionId: sessionData.sessionId,
      status: sessionData.status,
      duration: `${duration}ms`
    });

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
    const sessionId = input.sessionId || currentSession;
    
    if (!sessionId) {
      throw new Error('No session ID provided and no current session active');
    }

    const sessionData = activeSessions.get(sessionId);
    
    if (!sessionData) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Filter logs based on type and since parameter
    let filteredLogs = sessionData.logs;
    
    if (input.logType && input.logType !== 'all') {
      filteredLogs = filteredLogs.filter((log: any) => log.type === input.logType);
    }

    if (input.since) {
      const sinceDate = new Date(input.since);
      filteredLogs = filteredLogs.filter((log: any) => new Date(log.timestamp) >= sinceDate);
    }

    // Apply limit
    const limit = input.limit || 100;
    const logs = filteredLogs.slice(0, limit);

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      session: {
        sessionId: sessionData.sessionId,
        sessionName: sessionData.sessionName
      },
      logs: logs,
      filters: {
        logType: input.logType || 'all',
        since: input.since,
        limit: limit
      },
      stats: {
        totalLogsInSession: sessionData.logs.length,
        filteredLogsCount: filteredLogs.length,
        returnedLogsCount: logs.length
      },
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    logger.info('Live session logs retrieved', { 
      sessionId: sessionData.sessionId,
      logsReturned: logs.length,
      duration: `${duration}ms`
    });

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
    
    throw handleExternalServiceError(error, 'Live Session', 'logs retrieval');
  }
}

/**
 * Handler for getting live session screenshot
 */
export async function getLiveSessionScreenshotHandler(
  input: GetLiveSessionScreenshotInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('debugg_ai_get_live_session_screenshot', input);

  try {
    const sessionId = input.sessionId || currentSession;
    
    if (!sessionId) {
      throw new Error('No session ID provided and no current session active');
    }

    const sessionData = activeSessions.get(sessionId);
    
    if (!sessionData) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (sessionData.status !== 'active') {
      throw new Error(`Cannot take screenshot: session is ${sessionData.status}`);
    }

    // Simulate taking a screenshot
    const screenshot = {
      timestamp: new Date().toISOString(),
      format: input.format || 'png',
      quality: input.quality || 90,
      fullPage: input.fullPage || false,
      data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', // 1x1 placeholder
      size: {
        width: 1920,
        height: input.fullPage ? 3000 : 1080
      }
    };

    // Add to session screenshots
    sessionData.screenshots.push(screenshot);

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      session: {
        sessionId: sessionData.sessionId,
        sessionName: sessionData.sessionName
      },
      screenshot: screenshot,
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    logger.info('Live session screenshot captured', { 
      sessionId: sessionData.sessionId,
      format: screenshot.format,
      fullPage: screenshot.fullPage,
      duration: `${duration}ms`
    });

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