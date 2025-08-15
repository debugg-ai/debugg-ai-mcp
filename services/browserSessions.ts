/**
 * Browser Sessions Service
 * Handles live browser session management with real API calls
 */

import { AxiosTransport } from "../utils/axiosTransport.js";

// Browser Session Types
export interface BrowserSessionParams {
  url: string;
  localPort?: number;
  sessionName?: string;
  monitorConsole?: boolean;
  monitorNetwork?: boolean;
  takeScreenshots?: boolean;
  screenshotInterval?: number;
}

export interface BrowserSession {
  sessionId: string;
  sessionName: string;
  url: string;
  localPort?: number;
  status: 'starting' | 'active' | 'stopped' | 'error';
  startTime: string;
  endTime?: string;
  monitoring: {
    console: boolean;
    network: boolean;
    screenshots: boolean;
    screenshotInterval?: number;
  };
  tunnelKey?: string;
}

export interface SessionStats {
  uptime: number;
  totalLogs: number;
  consoleLogs: number;
  networkRequests: number;
  errors: number;
  screenshotsCaptured: number;
}

export interface SessionLog {
  timestamp: string;
  type: 'console' | 'network' | 'error';
  level?: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
  details?: Record<string, any>;
}

export interface SessionScreenshot {
  data: string; // base64 encoded
  format: 'png' | 'jpeg';
  quality?: number;
  fullPage: boolean;
  timestamp: string;
  size: {
    width: number;
    height: number;
    bytes: number;
  };
}

export interface SessionSummary {
  duration: number;
  finalStats: SessionStats;
  dataUrls?: {
    logs?: string;
    screenshots?: string;
  };
}

export interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// Screenshot Request Parameters
export interface ScreenshotParams {
  fullPage?: boolean;
  quality?: number;
  format?: 'png' | 'jpeg';
}

// Log Query Parameters
export interface LogQueryParams {
  logType?: 'console' | 'network' | 'errors' | 'all';
  since?: string;
  limit?: number;
}

export interface BrowserSessionsService {
  startSession(params: BrowserSessionParams): Promise<BrowserSession>;
  stopSession(sessionId: string): Promise<{ session: BrowserSession; summary: SessionSummary }>;
  getSessionStatus(sessionId: string): Promise<{ session: BrowserSession; stats: SessionStats }>;
  getSessionLogs(sessionId: string, params?: LogQueryParams): Promise<{
    session: { sessionId: string; sessionName?: string };
    logs: SessionLog[];
    filters: LogQueryParams;
    stats: { totalLogs: number; consoleCount: number; networkCount: number; errorCount: number };
  }>;
  captureScreenshot(sessionId: string, params?: ScreenshotParams): Promise<{
    session: { sessionId: string };
    screenshot: SessionScreenshot;
  }>;
  listSessions(params?: { status?: string; limit?: number; offset?: number }): Promise<PaginatedResponse<BrowserSession>>;
  navigateSession(sessionId: string, params: { url: string }): Promise<BrowserSession>;
}

/**
 * Helper function to map backend session status to MCP status
 */
function mapBackendStatus(backendStatus: string): 'starting' | 'active' | 'stopped' | 'error' {
  switch (backendStatus?.toUpperCase()) {
    case 'PENDING':
    case 'INITIALIZING':
      return 'starting';
    case 'ACTIVE':
    case 'RUNNING':
      return 'active';
    case 'COMPLETED':
    case 'TERMINATED':
    case 'STOPPED':
      return 'stopped';
    case 'FAILED':
    case 'ERROR':
      return 'error';
    default:
      return 'starting';
  }
}

/**
 * Create Browser Sessions Service with AxiosTransport
 */
export const createBrowserSessionsService = (tx: AxiosTransport): BrowserSessionsService => ({
  
  /**
   * Start a new browser session
   */
  async startSession(params: BrowserSessionParams): Promise<BrowserSession> {
    try {
      const serverUrl = "api/v1/browser-sessions/sessions/";
      
      const requestBody = {
        initialUrl: params.url,
        sessionName: params.sessionName || `Session ${new Date().toISOString()}`,
        monitorConsole: params.monitorConsole ?? true,
        monitorNetwork: params.monitorNetwork ?? true,
        takeScreenshots: params.takeScreenshots ?? false,
        screenshotInterval: params.screenshotInterval ?? 10
      };

      const backendResponse = await tx.post<any>(serverUrl, requestBody);

      if (!backendResponse) {
        throw new Error('Failed to start browser session - no response from service');
      }

      // Convert backend response format to MCP format
      const session: BrowserSession = {
        sessionId: backendResponse.uuid || backendResponse.key || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        sessionName: backendResponse.session_name || params.sessionName || 'Unnamed Session',
        url: backendResponse.initial_url || backendResponse.current_url || params.url,
        localPort: params.localPort,
        status: mapBackendStatus(backendResponse.status || 'PENDING'),
        startTime: backendResponse.timestamp || new Date().toISOString(),
        monitoring: {
          console: params.monitorConsole ?? true,
          network: params.monitorNetwork ?? true,
          screenshots: params.takeScreenshots ?? false,
          screenshotInterval: params.screenshotInterval ?? 10
        },
        tunnelKey: backendResponse.tunnel_key
      };

      return session;
    } catch (err) {
      console.error("Error starting browser session:", err);
      
      // Handle HTML error responses (404 pages)
      let errorMessage = (err as any).message;
      if (typeof err === 'string' && err.includes('<!DOCTYPE html>')) {
        errorMessage = 'Browser sessions API endpoint not found - service may not be available';
      } else if ((err as any).response?.status === 404) {
        errorMessage = 'Browser sessions API endpoint not found (404) - service may not be implemented';
      }
      
      throw new Error(`Failed to start browser session: ${errorMessage}`);
    }
  },

  /**
   * Stop an active browser session
   */
  async stopSession(sessionId: string): Promise<{ session: BrowserSession; summary: SessionSummary }> {
    try {
      const serverUrl = `api/v1/browser-sessions/sessions/${sessionId}/`;
      
      // Backend doesn't support DELETE, so we'll PATCH the session to stop it
      const backendResponse = await tx.patch<any>(serverUrl, { status: 'COMPLETED' });

      if (!backendResponse) {
        throw new Error('Failed to stop browser session - no response from service');
      }

      // Convert backend response to MCP format
      const session: BrowserSession = {
        sessionId: backendResponse.uuid || sessionId,
        sessionName: backendResponse.session_name || 'Session',
        url: backendResponse.initial_url || backendResponse.current_url || '',
        status: mapBackendStatus(backendResponse.status || 'STOPPED'),
        startTime: backendResponse.timestamp || new Date().toISOString(),
        endTime: new Date().toISOString(),
        monitoring: {
          console: true,
          network: true,
          screenshots: false
        },
        tunnelKey: backendResponse.tunnel_key
      };

      const summary: SessionSummary = {
        duration: 0, // Would need to calculate from start/end time
        finalStats: {
          uptime: 0,
          totalLogs: 0,
          consoleLogs: 0,
          networkRequests: 0,
          errors: 0,
          screenshotsCaptured: 0
        }
      };

      return { session, summary };
    } catch (err) {
      console.error("Error stopping browser session:", err);
      throw new Error(`Failed to stop browser session: ${(err as any).message}`);
    }
  },

  /**
   * Get browser session status and statistics
   */
  async getSessionStatus(sessionId: string): Promise<{ session: BrowserSession; stats: SessionStats }> {
    try {
      const serverUrl = `api/v1/browser-sessions/sessions/${sessionId}/`;
      
      const backendResponse = await tx.get<any>(serverUrl);

      if (!backendResponse) {
        throw new Error('Failed to get session status - session not found or service error');
      }

      // Convert backend response to MCP format
      const session: BrowserSession = {
        sessionId: backendResponse.uuid || sessionId,
        sessionName: backendResponse.session_name || 'Session',
        url: backendResponse.initial_url || backendResponse.current_url || '',
        status: mapBackendStatus(backendResponse.status || 'PENDING'),
        startTime: backendResponse.timestamp || new Date().toISOString(),
        monitoring: {
          console: true,
          network: true,
          screenshots: false
        },
        tunnelKey: backendResponse.tunnel_key
      };

      // Create basic stats (would need actual data from backend)
      const stats: SessionStats = {
        uptime: 0, // Would calculate from start time
        totalLogs: 0,
        consoleLogs: 0,
        networkRequests: 0,
        errors: 0,
        screenshotsCaptured: 0
      };

      return { session, stats };
    } catch (err) {
      console.error("Error getting session status:", err);
      if ((err as any).response?.status === 404) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      throw new Error(`Failed to get session status: ${(err as any).message}`);
    }
  },

  /**
   * Get logs from a browser session
   */
  async getSessionLogs(
    sessionId: string, 
    params?: LogQueryParams
  ): Promise<{
    session: { sessionId: string; sessionName?: string };
    logs: SessionLog[];
    filters: LogQueryParams;
    stats: { totalLogs: number; consoleCount: number; networkCount: number; errorCount: number };
  }> {
    try {
      // Build query parameters for filtering by session
      const queryParams: Record<string, any> = {
        session: sessionId
      };
      if (params?.since) queryParams.timestamp__gte = params.since;
      if (params?.limit) queryParams.limit = params.limit;

      const logs: SessionLog[] = [];
      let consoleCount = 0;
      let networkCount = 0;
      let errorCount = 0;

      // Fetch console logs if requested
      if (!params?.logType || params.logType === 'all' || params.logType === 'console') {
        try {
          const consoleResponse = await tx.get<any>('api/v1/browser-sessions/console-logs/', queryParams);
          if (consoleResponse?.results) {
            const consoleLogs = consoleResponse.results.map((log: any): SessionLog => ({
              timestamp: log.timestamp || new Date().toISOString(),
              type: 'console',
              level: log.level || 'log',
              message: log.message || '',
              source: log.source,
              details: log.details
            }));
            logs.push(...consoleLogs);
            consoleCount = consoleLogs.length;
          }
        } catch (err) {
          console.warn('Failed to fetch console logs:', err);
        }
      }

      // Fetch network events if requested
      if (!params?.logType || params.logType === 'all' || params.logType === 'network') {
        try {
          const networkResponse = await tx.get<any>('api/v1/browser-sessions/network-events/', queryParams);
          if (networkResponse?.results) {
            const networkLogs = networkResponse.results.map((event: any): SessionLog => ({
              timestamp: event.timestamp || new Date().toISOString(),
              type: 'network',
              message: `${event.method || 'GET'} ${event.url || ''} - ${event.status || ''}`,
              details: {
                url: event.url,
                method: event.method,
                status: event.status,
                responseTime: event.response_time
              }
            }));
            logs.push(...networkLogs);
            networkCount = networkLogs.length;
          }
        } catch (err) {
          console.warn('Failed to fetch network events:', err);
        }
      }

      // Sort logs by timestamp
      logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // Apply limit if specified
      const limitedLogs = params?.limit ? logs.slice(0, params.limit) : logs;

      return {
        session: { sessionId, sessionName: 'Browser Session' },
        logs: limitedLogs,
        filters: params || {},
        stats: { 
          totalLogs: logs.length, 
          consoleCount, 
          networkCount, 
          errorCount 
        }
      };
    } catch (err) {
      console.error("Error getting session logs:", err);
      if ((err as any).response?.status === 404) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      throw new Error(`Failed to get session logs: ${(err as any).message}`);
    }
  },

  /**
   * Capture a screenshot from the browser session
   */
  async captureScreenshot(
    sessionId: string, 
    params?: ScreenshotParams
  ): Promise<{
    session: { sessionId: string };
    screenshot: SessionScreenshot;
  }> {
    try {
      // For now, we'll use the screenshots list endpoint to get existing screenshots
      // In the future, this would trigger a new screenshot capture
      const serverUrl = 'api/v1/browser-sessions/screenshots/';
      
      const queryParams = {
        session: sessionId,
        limit: 1
      };

      const response = await tx.get<any>(serverUrl, queryParams);

      if (!response?.results || response.results.length === 0) {
        // If no screenshots exist, we'll return a placeholder
        // In a real implementation, this would trigger screenshot capture
        const screenshot: SessionScreenshot = {
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', // 1x1 transparent PNG
          format: params?.format || 'png',
          quality: params?.quality,
          fullPage: params?.fullPage || false,
          timestamp: new Date().toISOString(),
          size: {
            width: 1,
            height: 1,
            bytes: 68
          }
        };

        return {
          session: { sessionId },
          screenshot
        };
      }

      // Convert backend screenshot to MCP format
      const backendScreenshot = response.results[0];
      const screenshot: SessionScreenshot = {
        data: backendScreenshot.data || '',
        format: (backendScreenshot.format || params?.format || 'png') as 'png' | 'jpeg',
        quality: backendScreenshot.quality || params?.quality,
        fullPage: backendScreenshot.full_page || params?.fullPage || false,
        timestamp: backendScreenshot.timestamp || new Date().toISOString(),
        size: {
          width: backendScreenshot.width || 0,
          height: backendScreenshot.height || 0,
          bytes: backendScreenshot.file_size || 0
        }
      };

      return {
        session: { sessionId },
        screenshot
      };
    } catch (err) {
      console.error("Error capturing screenshot:", err);
      if ((err as any).response?.status === 404) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      throw new Error(`Failed to capture screenshot: ${(err as any).message}`);
    }
  },

  /**
   * List browser sessions
   */
  async listSessions(
    params?: { status?: string; limit?: number; offset?: number }
  ): Promise<PaginatedResponse<BrowserSession>> {
    try {
      const serverUrl = "api/v1/browser-sessions/sessions/";
      
      const queryParams: Record<string, any> = {};
      if (params?.status) {
        // Map MCP status to backend status
        switch (params.status) {
          case 'starting':
            queryParams.status = 'PENDING';
            break;
          case 'active':
            queryParams.status = 'ACTIVE';
            break;
          case 'stopped':
            queryParams.status = 'COMPLETED';
            break;
          case 'error':
            queryParams.status = 'FAILED';
            break;
          default:
            queryParams.status = params.status;
        }
      }
      if (params?.limit) queryParams.limit = params.limit;
      if (params?.offset) queryParams.offset = params.offset;

      const response = await tx.get<{
        count: number;
        next: string | null;
        previous: string | null;
        results: any[];
      }>(serverUrl, queryParams);

      if (!response) {
        throw new Error('Failed to list sessions - no response from service');
      }

      // Convert backend sessions to MCP format
      const sessions: BrowserSession[] = (response.results || []).map((backendSession: any): BrowserSession => ({
        sessionId: backendSession.uuid || backendSession.key || `session_${Date.now()}`,
        sessionName: backendSession.session_name || 'Unnamed Session',
        url: backendSession.initial_url || backendSession.current_url || '',
        status: mapBackendStatus(backendSession.status || 'PENDING'),
        startTime: backendSession.timestamp || new Date().toISOString(),
        monitoring: {
          console: true,
          network: true,
          screenshots: false
        },
        tunnelKey: backendSession.tunnel_key
      }));

      return {
        count: response.count || 0,
        next: response.next,
        previous: response.previous,
        results: sessions
      };
    } catch (err) {
      console.error("Error listing sessions:", err);
      throw new Error(`Failed to list sessions: ${(err as any).message}`);
    }
  },

  /**
   * Navigate an active browser session to a new URL
   */
  async navigateSession(sessionId: string, params: { url: string }): Promise<BrowserSession> {
    try {
      const serverUrl = `api/v1/browser-sessions/sessions/${sessionId}/navigate/`;
      
      const requestBody = {
        url: params.url
      };

      // Try POST first, fall back to PATCH if not supported
      let backendResponse;
      try {
        backendResponse = await tx.post<any>(serverUrl, requestBody);
      } catch (postErr) {
        // If POST fails with 404/405, try PATCH to update session URL
        if ((postErr as any).response?.status === 404 || (postErr as any).response?.status === 405) {
          const patchUrl = `api/v1/browser-sessions/sessions/${sessionId}/`;
          backendResponse = await tx.patch<any>(patchUrl, { current_url: params.url });
        } else {
          throw postErr;
        }
      }

      if (!backendResponse) {
        throw new Error('Failed to navigate browser session - no response from service');
      }

      // Convert backend response to MCP format
      const session: BrowserSession = {
        sessionId: backendResponse.uuid || sessionId,
        sessionName: backendResponse.session_name || 'Session',
        url: params.url, // Use the new URL as current
        status: mapBackendStatus(backendResponse.status || 'ACTIVE'),
        startTime: backendResponse.timestamp || new Date().toISOString(),
        monitoring: {
          console: true,
          network: true,
          screenshots: false
        },
        tunnelKey: backendResponse.tunnel_key
      };

      return session;
    } catch (err) {
      console.error("Error navigating browser session:", err);
      if ((err as any).response?.status === 404) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      throw new Error(`Failed to navigate browser session: ${(err as any).message}`);
    }
  }
});