/**
 * Browser Sessions Service
 * Handles live browser session management with real API calls
 */

import { AxiosTransport } from "../utils/axiosTransport.js";

// Browser Session Types
export interface BrowserSessionParams {
  url: string;
  originalUrl?: string;
  localPort?: number;
  sessionName?: string;
  monitorConsole?: boolean;
  monitorNetwork?: boolean;
  takeScreenshots?: boolean;
  screenshotInterval?: number;
  isLocalhost?: boolean;
  tunnelId?: string;
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

// Quick Screenshot Parameters
export interface QuickScreenshotParams {
  url: string;
  type?: 'VIEWPORT' | 'FULL_PAGE';
}

// Quick Screenshot Response
export interface QuickScreenshotResponse {
  taskId: string;
  sessionId: string;
  screenshotActionId: string;
  url: string;
  screenshotType: string;
  status: string;
  message: string;
  polling: {
    statusUrl: string;
    downloadUrlAvailableWhenComplete: string;
    pollIntervalSeconds: number;
  };
  sessionInfo: {
    sessionName: string;
    status: string;
    vncUrl: string;
    createdAt: string;
  };
}

// Quick Screenshot Status Response
export interface QuickScreenshotStatusResponse {
  taskId: string;
  sessionId: string;
  screenshotActionId: string;
  url: string;
  screenshotType: string;
  status: string;
  message: string;
  downloadUrl?: string;
  sessionInfo: {
    sessionName: string;
    status: string;
    vncUrl: string;
    createdAt: string;
  };
}

// Quick Screenshot Download Response
export interface QuickScreenshotDownloadResponse {
  downloadUrl: string;
  expiresAt: string;
  fileSize: number;
  mimeType: string;
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
  quickScreenshot(params: QuickScreenshotParams): Promise<QuickScreenshotResponse>;
  getQuickScreenshotStatus(taskId: string): Promise<QuickScreenshotStatusResponse>;
  getQuickScreenshotDownload(taskId: string): Promise<QuickScreenshotDownloadResponse>;
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

      const requestBody: Record<string, any> = {
        initialUrl: params.url,
        sessionName: params.sessionName || `Session ${new Date().toISOString()}`,
        // Let the AxiosTransport interceptor convert these to snake_case
      };

      // Add optional parameters if provided
      if (params.originalUrl) requestBody.originalUrl = params.originalUrl;
      if (params.localPort !== undefined) requestBody.localPort = params.localPort;
      if (params.monitorConsole !== undefined) requestBody.monitorConsole = params.monitorConsole;
      if (params.monitorNetwork !== undefined) requestBody.monitorNetwork = params.monitorNetwork;
      if (params.takeScreenshots !== undefined) requestBody.takeScreenshots = params.takeScreenshots;
      if (params.screenshotInterval !== undefined) requestBody.screenshotInterval = params.screenshotInterval;
      if (params.isLocalhost !== undefined) requestBody.isLocalhost = params.isLocalhost;
      if (params.tunnelId) requestBody.tunnelId = params.tunnelId;

      const backendResponse = await tx.post<any>(serverUrl, requestBody);

      if (!backendResponse) {
        throw new Error('Failed to start browser session - no response from service');
      }

      // Return the backend response directly
      return backendResponse;
    } catch (err) {
      console.error("Error starting browser session:", err);
      throw new Error(`Failed to start browser session: ${(err as any).message}`);
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

      // Return the backend response directly
      return { session: backendResponse, summary: backendResponse.summary || {} };
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

      // Return the backend response directly
      return { session: backendResponse, stats: backendResponse.stats || {} };
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

      // Use the appropriate logs endpoint based on logType
      let serverUrl = 'api/v1/browser-sessions/logs/';
      if (params?.logType && params.logType !== 'all') {
        switch (params.logType) {
          case 'console':
            serverUrl = 'api/v1/browser-sessions/console-logs/';
            break;
          case 'network':
            serverUrl = 'api/v1/browser-sessions/network-events/';
            break;
          case 'errors':
            serverUrl = 'api/v1/browser-sessions/error-logs/';
            break;
        }
      }

      const response = await tx.get<any>(serverUrl, queryParams);
      
      // Return the backend response directly
      return {
        session: response.session || { sessionId },
        logs: response.logs || response.results || [],
        filters: params || {},
        stats: response.stats || { totalLogs: 0, consoleCount: 0, networkCount: 0, errorCount: 0 }
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
      // POST to trigger a new screenshot capture
      const serverUrl = `api/v1/browser-sessions/sessions/${sessionId}/screenshot/`;
      
      const requestBody = {
        fullPage: params?.fullPage,
        quality: params?.quality,
        format: params?.format
      };

      const response = await tx.post<any>(serverUrl, requestBody);

      // Return the backend response directly
      return {
        session: response.session || { sessionId },
        screenshot: response.screenshot || response
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
      if (params?.status) queryParams.status = params.status;
      if (params?.limit) queryParams.limit = params.limit;
      if (params?.offset) queryParams.offset = params.offset;

      const response = await tx.get<{
        count: number;
        next: string | null;
        previous: string | null;
        results: any[];
      }>(serverUrl, queryParams);

      // Handle case where backend returns no data or empty response
      if (!response) {
        return {
          count: 0,
          next: null,
          previous: null,
          results: []
        };
      }

      // Return the backend response directly, with safe defaults
      return {
        count: response.count || 0,
        next: response.next || null,
        previous: response.previous || null,
        results: response.results || []
      };
    } catch (err) {
      console.error("Error listing sessions:", err);
      
      // If the API endpoint doesn't exist or returns 404, return empty list
      if ((err as any).response?.status === 404) {
        return {
          count: 0,
          next: null,
          previous: null,
          results: []
        };
      }
      
      // For other errors, still return empty list but log the error
      console.warn("Returning empty sessions list due to API error:", (err as any).message);
      return {
        count: 0,
        next: null,
        previous: null,
        results: []
      };
    }
  },

  /**
   * Quick screenshot - opens new tab, navigates to URL and takes screenshot
   */
  async quickScreenshot(params: QuickScreenshotParams): Promise<QuickScreenshotResponse> {
    try {
      const serverUrl = "api/v1/browser-sessions/sessions/quick_screenshot/";
      
      const requestBody = {
        url: params.url,
        type: params.type || 'VIEWPORT'
      };

      const response = await tx.post<QuickScreenshotResponse>(serverUrl, requestBody);

      if (!response) {
        throw new Error('Failed to initiate quick screenshot - no response from service');
      }

      return response;
    } catch (err) {
      console.error("Error taking quick screenshot:", err);
      throw new Error(`Failed to take quick screenshot: ${(err as any).message}`);
    }
  },

  /**
   * Get quick screenshot status - check if screenshot task is completed
   */
  async getQuickScreenshotStatus(taskId: string): Promise<QuickScreenshotStatusResponse> {
    try {
      const serverUrl = `api/v1/browser-sessions/sessions/quick_screenshot_status/?task_id=${taskId}`;
      
      const response = await tx.get<QuickScreenshotStatusResponse>(serverUrl);

      if (!response) {
        throw new Error('Failed to get quick screenshot status - task not found');
      }

      return response;
    } catch (err) {
      console.error("Error getting quick screenshot status:", err);
      if ((err as any).response?.status === 404) {
        throw new Error(`Task not found: ${taskId}`);
      }
      throw new Error(`Failed to get quick screenshot status: ${(err as any).message}`);
    }
  },

  /**
   * Get quick screenshot download URL when completed
   */
  async getQuickScreenshotDownload(taskId: string): Promise<QuickScreenshotDownloadResponse> {
    try {
      const serverUrl = `api/v1/browser-sessions/sessions/quick_screenshot_download/?task_id=${taskId}`;
      
      const response = await tx.get<QuickScreenshotDownloadResponse>(serverUrl);

      if (!response) {
        throw new Error('Failed to get quick screenshot download - task not found or not ready');
      }

      return response;
    } catch (err) {
      console.error("Error getting quick screenshot download:", err);
      if ((err as any).response?.status === 404) {
        throw new Error(`Task not found or download not ready: ${taskId}`);
      }
      throw new Error(`Failed to get quick screenshot download: ${(err as any).message}`);
    }
  }
});