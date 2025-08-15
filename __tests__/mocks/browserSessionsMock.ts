/**
 * Mock implementation of Browser Sessions Service for testing
 */

import { 
  BrowserSessionsService, 
  BrowserSession, 
  BrowserSessionParams,
  SessionStats,
  SessionSummary,
  SessionLog,
  SessionScreenshot,
  LogQueryParams,
  ScreenshotParams,
  PaginatedResponse
} from '../../services/browserSessions.js';

// In-memory storage for mock sessions
const mockSessions = new Map<string, BrowserSession>();
const mockLogs = new Map<string, SessionLog[]>();
const mockScreenshots = new Map<string, SessionScreenshot[]>();

let sessionCounter = 0;

/**
 * Generate a mock session ID
 */
function generateSessionId(): string {
  return `mock_session_${Date.now()}_${++sessionCounter}`;
}

/**
 * Generate mock logs for a session
 */
function generateMockLogs(sessionId: string, count: number = 5): SessionLog[] {
  const logs: SessionLog[] = [];
  const now = Date.now();
  
  for (let i = 0; i < count; i++) {
    logs.push({
      timestamp: new Date(now - (count - i) * 1000).toISOString(),
      type: i % 3 === 0 ? 'console' : i % 3 === 1 ? 'network' : 'error',
      level: i % 4 === 0 ? 'info' : i % 4 === 1 ? 'warn' : 'log',
      message: `Mock log message ${i + 1} for session ${sessionId}`,
      source: `mock-source-${i}`,
      details: { mockData: `test-data-${i}` }
    });
  }
  
  return logs;
}

/**
 * Generate a mock screenshot
 */
function generateMockScreenshot(sessionId: string, params?: ScreenshotParams): SessionScreenshot {
  return {
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', // 1x1 transparent PNG
    format: params?.format || 'png',
    quality: params?.quality,
    fullPage: params?.fullPage || false,
    timestamp: new Date().toISOString(),
    size: {
      width: params?.fullPage ? 1920 : 800,
      height: params?.fullPage ? 1080 : 600,
      bytes: 68
    }
  };
}

/**
 * Create Mock Browser Sessions Service
 */
export const createMockBrowserSessionsService = (): BrowserSessionsService => ({
  
  async startSession(params: BrowserSessionParams): Promise<BrowserSession> {
    const sessionId = generateSessionId();
    
    const session: BrowserSession = {
      sessionId,
      sessionName: params.sessionName || `Mock Session ${sessionId}`,
      url: params.url,
      localPort: params.localPort,
      status: 'active', // Mock sessions start as active immediately
      startTime: new Date().toISOString(),
      monitoring: {
        console: params.monitorConsole ?? true,
        network: params.monitorNetwork ?? true,
        screenshots: params.takeScreenshots ?? false,
        screenshotInterval: params.screenshotInterval ?? 10
      },
      tunnelKey: `mock_tunnel_${sessionId}`
    };

    // Store the session
    mockSessions.set(sessionId, session);
    
    // Generate some mock logs
    const logs = generateMockLogs(sessionId);
    mockLogs.set(sessionId, logs);
    
    // Generate mock screenshots if enabled
    if (params.takeScreenshots) {
      const screenshots = [generateMockScreenshot(sessionId)];
      mockScreenshots.set(sessionId, screenshots);
    }

    return session;
  },

  async stopSession(sessionId: string): Promise<{ session: BrowserSession; summary: SessionSummary }> {
    const session = mockSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Update session status
    const stoppedSession: BrowserSession = {
      ...session,
      status: 'stopped',
      endTime: new Date().toISOString()
    };

    mockSessions.set(sessionId, stoppedSession);

    const startTime = new Date(session.startTime).getTime();
    const endTime = new Date().getTime();
    const duration = endTime - startTime;

    const logs = mockLogs.get(sessionId) || [];
    const screenshots = mockScreenshots.get(sessionId) || [];

    const summary: SessionSummary = {
      duration,
      finalStats: {
        uptime: duration,
        totalLogs: logs.length,
        consoleLogs: logs.filter(log => log.type === 'console').length,
        networkRequests: logs.filter(log => log.type === 'network').length,
        errors: logs.filter(log => log.type === 'error').length,
        screenshotsCaptured: screenshots.length
      }
    };

    return { session: stoppedSession, summary };
  },

  async getSessionStatus(sessionId: string): Promise<{ session: BrowserSession; stats: SessionStats }> {
    const session = mockSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const startTime = new Date(session.startTime).getTime();
    const currentTime = Date.now();
    const uptime = currentTime - startTime;

    const logs = mockLogs.get(sessionId) || [];
    const screenshots = mockScreenshots.get(sessionId) || [];

    const stats: SessionStats = {
      uptime,
      totalLogs: logs.length,
      consoleLogs: logs.filter(log => log.type === 'console').length,
      networkRequests: logs.filter(log => log.type === 'network').length,
      errors: logs.filter(log => log.type === 'error').length,
      screenshotsCaptured: screenshots.length
    };

    return { session, stats };
  },

  async getSessionLogs(sessionId: string, params?: LogQueryParams): Promise<{
    session: { sessionId: string; sessionName?: string };
    logs: SessionLog[];
    filters: LogQueryParams;
    stats: { totalLogs: number; consoleCount: number; networkCount: number; errorCount: number };
  }> {
    const session = mockSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    let logs = mockLogs.get(sessionId) || [];

    // Apply filters
    if (params?.logType && params.logType !== 'all') {
      logs = logs.filter(log => log.type === params.logType);
    }

    if (params?.since) {
      const sinceTime = new Date(params.since).getTime();
      logs = logs.filter(log => new Date(log.timestamp).getTime() >= sinceTime);
    }

    // Apply limit
    if (params?.limit) {
      logs = logs.slice(0, params.limit);
    }

    const allLogs = mockLogs.get(sessionId) || [];
    const stats = {
      totalLogs: allLogs.length,
      consoleCount: allLogs.filter(log => log.type === 'console').length,
      networkCount: allLogs.filter(log => log.type === 'network').length,
      errorCount: allLogs.filter(log => log.type === 'error').length
    };

    return {
      session: { sessionId, sessionName: session.sessionName },
      logs,
      filters: params || {},
      stats
    };
  },

  async captureScreenshot(sessionId: string, params?: ScreenshotParams): Promise<{
    session: { sessionId: string };
    screenshot: SessionScreenshot;
  }> {
    const session = mockSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== 'active') {
      throw new Error('Cannot take screenshot: session is stopped');
    }

    const screenshot = generateMockScreenshot(sessionId, params);
    
    // Add to stored screenshots
    const existingScreenshots = mockScreenshots.get(sessionId) || [];
    existingScreenshots.push(screenshot);
    mockScreenshots.set(sessionId, existingScreenshots);

    return {
      session: { sessionId },
      screenshot
    };
  },

  async listSessions(params?: { status?: string; limit?: number; offset?: number }): Promise<PaginatedResponse<BrowserSession>> {
    let sessions = Array.from(mockSessions.values());

    // Apply status filter
    if (params?.status) {
      sessions = sessions.filter(session => session.status === params.status);
    }

    const total = sessions.length;

    // Apply pagination
    if (params?.offset) {
      sessions = sessions.slice(params.offset);
    }
    if (params?.limit) {
      sessions = sessions.slice(0, params.limit);
    }

    return {
      count: total,
      next: null, // Simplified for mock
      previous: null, // Simplified for mock
      results: sessions
    };
  }
});

/**
 * Clear all mock data (useful for test cleanup)
 */
export function clearMockData() {
  mockSessions.clear();
  mockLogs.clear();
  mockScreenshots.clear();
  sessionCounter = 0;
}

/**
 * Create a comprehensive mock service for offline development
 * Includes realistic delays, error scenarios, and rich test data
 */
export const createOfflineBrowserSessionsService = (options?: {
  latency?: number;
  errorRate?: number;
  realistic?: boolean;
}): BrowserSessionsService => {
  const { latency = 50, errorRate = 0.05, realistic = true } = options || {};

  // Helper to simulate network latency
  const delay = (ms: number = latency) => new Promise(resolve => setTimeout(resolve, ms));

  // Helper to randomly trigger errors
  const shouldError = () => Math.random() < errorRate;

  // Helper to generate realistic data
  const generateRealisticLogs = (sessionId: string, count: number): SessionLog[] => {
    const logs: SessionLog[] = [];
    const now = Date.now();
    const logTypes = ['console', 'network', 'error'];
    const logLevels = ['info', 'warn', 'error', 'debug', 'log'];
    
    const realisticMessages = {
      console: [
        'Application initialized successfully',
        'User authentication completed',
        'Loading dashboard components...',
        'API request completed in 145ms',
        'Cache hit for user preferences',
        'Navigation to /dashboard successful'
      ],
      network: [
        'GET /api/users - 200 OK (89ms)',
        'POST /api/auth/login - 200 OK (156ms)',
        'GET /api/dashboard/stats - 200 OK (234ms)',
        'PUT /api/user/preferences - 200 OK (67ms)',
        'DELETE /api/session/temp - 204 No Content (23ms)'
      ],
      error: [
        'Failed to load resource: net::ERR_NETWORK_CHANGED',
        'Uncaught TypeError: Cannot read property of null',
        'API rate limit exceeded (429)',
        'Session expired, redirecting to login',
        'WebSocket connection failed'
      ]
    };

    for (let i = 0; i < count; i++) {
      const type = logTypes[i % logTypes.length] as 'console' | 'network' | 'error';
      const level = logLevels[i % logLevels.length] as 'info' | 'warn' | 'error' | 'debug' | 'log';
      const messages = realisticMessages[type];
      
      logs.push({
        timestamp: new Date(now - (count - i) * 2000 + Math.random() * 1000).toISOString(),
        type,
        level,
        message: messages[i % messages.length],
        source: `component-${Math.floor(i / 3)}.js:${12 + i * 3}`,
        details: type === 'network' ? {
          url: `/api/${type === 'network' ? 'endpoint' : 'resource'}-${i}`,
          method: ['GET', 'POST', 'PUT', 'DELETE'][i % 4],
          status: 200,
          responseTime: 50 + Math.random() * 200
        } : {
          userId: `user-${sessionId}`,
          sessionContext: `context-${i}`
        }
      });
    }

    return logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  };

  return {
    async startSession(params: BrowserSessionParams): Promise<BrowserSession> {
      await delay();

      if (shouldError()) {
        throw new Error('Mock: Failed to connect to browser automation service');
      }

      const sessionId = generateSessionId();
      
      const session: BrowserSession = {
        sessionId,
        sessionName: params.sessionName || `Offline Development Session ${sessionCounter}`,
        url: params.url,
        localPort: params.localPort,
        status: 'starting', // More realistic initial status
        startTime: new Date().toISOString(),
        monitoring: {
          console: params.monitorConsole ?? true,
          network: params.monitorNetwork ?? true,
          screenshots: params.takeScreenshots ?? false,
          screenshotInterval: params.screenshotInterval ?? 10
        },
        tunnelKey: `offline_tunnel_${sessionId}_${Date.now()}`
      };

      mockSessions.set(sessionId, session);

      // Simulate session becoming active after a short delay
      setTimeout(() => {
        const activeSession = { ...session, status: 'active' as const };
        mockSessions.set(sessionId, activeSession);
        
        if (realistic) {
          // Generate realistic logs over time
          const logs = generateRealisticLogs(sessionId, 15);
          mockLogs.set(sessionId, logs);
          
          // Generate periodic screenshots if enabled
          if (params.takeScreenshots) {
            const screenshots = [
              generateMockScreenshot(sessionId, { format: 'png', fullPage: false }),
              generateMockScreenshot(sessionId, { format: 'png', fullPage: true })
            ];
            mockScreenshots.set(sessionId, screenshots);
          }
        }
      }, 100 + Math.random() * 200);

      return session;
    },

    async stopSession(sessionId: string): Promise<{ session: BrowserSession; summary: SessionSummary }> {
      await delay(latency + Math.random() * 50);

      if (shouldError()) {
        throw new Error('Mock: Failed to stop session - connection timeout');
      }

      const session = mockSessions.get(sessionId);
      if (!session) {
        throw new Error(`Mock: Session not found: ${sessionId}`);
      }

      const stoppedSession: BrowserSession = {
        ...session,
        status: 'stopped',
        endTime: new Date().toISOString()
      };

      mockSessions.set(sessionId, stoppedSession);

      const startTime = new Date(session.startTime).getTime();
      const endTime = new Date().getTime();
      const duration = endTime - startTime;

      const logs = mockLogs.get(sessionId) || [];
      const screenshots = mockScreenshots.get(sessionId) || [];

      const summary: SessionSummary = {
        duration,
        finalStats: {
          uptime: duration,
          totalLogs: logs.length,
          consoleLogs: logs.filter(log => log.type === 'console').length,
          networkRequests: logs.filter(log => log.type === 'network').length,
          errors: logs.filter(log => log.type === 'error').length,
          screenshotsCaptured: screenshots.length
        },
        dataUrls: realistic ? {
          logs: `data:application/json;base64,${Buffer.from(JSON.stringify(logs)).toString('base64')}`,
          screenshots: screenshots.length > 0 ? `data:application/json;base64,${Buffer.from(JSON.stringify(screenshots.map(s => s.data))).toString('base64')}` : undefined
        } : undefined
      };

      return { session: stoppedSession, summary };
    },

    async getSessionStatus(sessionId: string): Promise<{ session: BrowserSession; stats: SessionStats }> {
      await delay(Math.random() * 30); // Faster for status checks

      if (shouldError()) {
        throw new Error('Mock: Network error while fetching session status');
      }

      const session = mockSessions.get(sessionId);
      if (!session) {
        throw new Error(`Mock: Session not found: ${sessionId}`);
      }

      const startTime = new Date(session.startTime).getTime();
      const currentTime = Date.now();
      const uptime = currentTime - startTime;

      const logs = mockLogs.get(sessionId) || [];
      const screenshots = mockScreenshots.get(sessionId) || [];

      const stats: SessionStats = {
        uptime,
        totalLogs: logs.length,
        consoleLogs: logs.filter(log => log.type === 'console').length,
        networkRequests: logs.filter(log => log.type === 'network').length,
        errors: logs.filter(log => log.type === 'error').length,
        screenshotsCaptured: screenshots.length
      };

      return { session, stats };
    },

    async getSessionLogs(sessionId: string, params?: LogQueryParams): Promise<{
      session: { sessionId: string; sessionName?: string };
      logs: SessionLog[];
      filters: LogQueryParams;
      stats: { totalLogs: number; consoleCount: number; networkCount: number; errorCount: number };
    }> {
      await delay(latency + Math.random() * 100);

      if (shouldError()) {
        throw new Error('Mock: Failed to retrieve session logs - service unavailable');
      }

      const session = mockSessions.get(sessionId);
      if (!session) {
        throw new Error(`Mock: Session not found: ${sessionId}`);
      }

      let logs = mockLogs.get(sessionId) || [];

      // Apply filters
      if (params?.logType && params.logType !== 'all') {
        logs = logs.filter(log => log.type === params.logType);
      }

      if (params?.since) {
        const sinceTime = new Date(params.since).getTime();
        logs = logs.filter(log => new Date(log.timestamp).getTime() >= sinceTime);
      }

      // Apply limit
      if (params?.limit) {
        logs = logs.slice(0, params.limit);
      }

      const allLogs = mockLogs.get(sessionId) || [];
      const stats = {
        totalLogs: allLogs.length,
        consoleCount: allLogs.filter(log => log.type === 'console').length,
        networkCount: allLogs.filter(log => log.type === 'network').length,
        errorCount: allLogs.filter(log => log.type === 'error').length
      };

      return {
        session: { sessionId, sessionName: session.sessionName },
        logs,
        filters: params || {},
        stats
      };
    },

    async captureScreenshot(sessionId: string, params?: ScreenshotParams): Promise<{
      session: { sessionId: string };
      screenshot: SessionScreenshot;
    }> {
      await delay(latency * 2); // Screenshots take longer

      if (shouldError()) {
        throw new Error('Mock: Screenshot capture failed - browser not responding');
      }

      const session = mockSessions.get(sessionId);
      if (!session) {
        throw new Error(`Mock: Session not found: ${sessionId}`);
      }

      if (session.status !== 'active') {
        throw new Error('Mock: Cannot take screenshot: session is not active');
      }

      const screenshot: SessionScreenshot = {
        data: realistic ? 
          // More realistic base64 PNG data
          'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAB3RJTUUH5QcJEzAi9RrWBQAAAFZJREFUGNNjYGBgYPj//z8DNQHIB4k1NgAAAABJRU5ErkJggg==' :
          generateMockScreenshot(sessionId, params).data,
        format: params?.format || 'png',
        quality: params?.quality || (params?.format === 'jpeg' ? 85 : undefined),
        fullPage: params?.fullPage || false,
        timestamp: new Date().toISOString(),
        size: {
          width: params?.fullPage ? 1920 : 1280,
          height: params?.fullPage ? (1080 + Math.floor(Math.random() * 2000)) : 720,
          bytes: params?.format === 'jpeg' ? 45000 + Math.floor(Math.random() * 20000) : 12000 + Math.floor(Math.random() * 8000)
        }
      };
      
      // Add to stored screenshots
      const existingScreenshots = mockScreenshots.get(sessionId) || [];
      existingScreenshots.push(screenshot);
      mockScreenshots.set(sessionId, existingScreenshots);

      return {
        session: { sessionId },
        screenshot
      };
    },

    async listSessions(params?: { status?: string; limit?: number; offset?: number }): Promise<PaginatedResponse<BrowserSession>> {
      await delay(Math.random() * 40);

      if (shouldError()) {
        throw new Error('Mock: Failed to list sessions - database connection error');
      }

      let sessions = Array.from(mockSessions.values());

      // Apply status filter
      if (params?.status) {
        sessions = sessions.filter(session => session.status === params.status);
      }

      const total = sessions.length;

      // Apply pagination
      let offset = params?.offset || 0;
      let limit = params?.limit || 50;
      
      const hasNext = offset + limit < total;
      const hasPrevious = offset > 0;

      sessions = sessions.slice(offset, offset + limit);

      return {
        count: total,
        next: hasNext ? `mock://sessions?offset=${offset + limit}&limit=${limit}` : null,
        previous: hasPrevious ? `mock://sessions?offset=${Math.max(0, offset - limit)}&limit=${limit}` : null,
        results: sessions
      };
    },

    async navigateSession(sessionId: string, params: { url: string }): Promise<BrowserSession> {
      await delay(latency + Math.random() * 100);

      if (shouldError()) {
        throw new Error('Mock: Navigation failed - page load timeout');
      }

      const session = mockSessions.get(sessionId);
      if (!session) {
        throw new Error(`Mock: Session not found: ${sessionId}`);
      }

      if (session.status !== 'active') {
        throw new Error('Mock: Cannot navigate: session is not active');
      }

      const updatedSession: BrowserSession = {
        ...session,
        url: params.url // Update current URL
      };

      mockSessions.set(sessionId, updatedSession);

      // Add a navigation log
      if (realistic) {
        const logs = mockLogs.get(sessionId) || [];
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'console',
          level: 'info',
          message: `Navigation to ${params.url} completed successfully`,
          source: 'navigation-service.js:45',
          details: { previousUrl: session.url, newUrl: params.url, duration: latency + Math.random() * 100 }
        });
        mockLogs.set(sessionId, logs);
      }

      return updatedSession;
    }
  };
};

/**
 * Create a realistic dataset for testing
 */
export function createRealisticTestData() {
  const service = createOfflineBrowserSessionsService({ realistic: true, errorRate: 0 });
  
  const testScenarios = [
    {
      url: 'http://localhost:3000/dashboard',
      sessionName: 'Dashboard E2E Test',
      monitorConsole: true,
      monitorNetwork: true,
      takeScreenshots: true
    },
    {
      url: 'http://localhost:8080/admin/users',
      sessionName: 'Admin User Management Test',
      monitorConsole: true,
      monitorNetwork: true,
      takeScreenshots: false
    },
    {
      url: 'https://staging.example.com/checkout',
      sessionName: 'Checkout Flow Integration Test',
      monitorConsole: true,
      monitorNetwork: true,
      takeScreenshots: true,
      screenshotInterval: 5
    }
  ];

  return { service, testScenarios };
}

/**
 * Network condition simulator for testing different scenarios
 */
export class NetworkConditionSimulator {
  private conditions = {
    fast: { latency: 10, errorRate: 0.01, reliability: 0.99 },
    normal: { latency: 50, errorRate: 0.05, reliability: 0.95 },
    slow: { latency: 200, errorRate: 0.1, reliability: 0.85 },
    unreliable: { latency: 500, errorRate: 0.25, reliability: 0.6 },
    offline: { latency: 0, errorRate: 1.0, reliability: 0 }
  };

  createServiceWithCondition(condition: keyof typeof this.conditions) {
    const config = this.conditions[condition];
    return createOfflineBrowserSessionsService({
      latency: config.latency,
      errorRate: config.errorRate,
      realistic: true
    });
  }

  getAllConditions() {
    return Object.keys(this.conditions);
  }
}