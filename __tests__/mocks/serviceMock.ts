/**
 * Mock DebuggAI service client for testing
 */

export interface MockBrowserSession {
  sessionId: string;
  url: string;
  originalUrl?: string;
  sessionName: string;
  status: 'active' | 'stopped' | 'error';
  startTime: string;
  endTime?: string;
  monitoring: {
    console: boolean;
    network: boolean;
    screenshots: boolean;
    screenshotInterval?: number;
  };
  localPort?: number;
  isLocalhost?: boolean;
  tunnelId?: string;
}

export interface MockSessionStats {
  uptime: number;
  pageLoads: number;
  consoleMessages: number;
  networkRequests: number;
  screenshotsCaptured: number;
}

export interface MockSessionLogs {
  sessionId: string;
  logs: Array<{
    timestamp: string;
    type: 'console' | 'network' | 'error';
    level: 'log' | 'warn' | 'error' | 'info';
    message: string;
    data?: any;
  }>;
  filters: {
    logType: string;
    since?: string;
    limit: number;
  };
  stats: {
    total: number;
    console: number;
    network: number;
    errors: number;
  };
}

export interface MockScreenshot {
  sessionId: string;
  screenshot: {
    data: string; // base64 encoded image
    format: 'png' | 'jpeg';
    quality: number;
    fullPage: boolean;
    size: {
      width: number;
      height: number;
    };
    timestamp: string;
  };
}

// Mock storage for sessions
const mockSessions = new Map<string, MockBrowserSession>();
let sessionIdCounter = 1000;

function generateSessionId(): string {
  return `session-${sessionIdCounter++}-${Date.now()}`;
}

function createMockSession(params: any): MockBrowserSession {
  const sessionId = generateSessionId();
  return {
    sessionId,
    url: params.url,
    originalUrl: params.originalUrl,
    sessionName: params.sessionName || `Session ${new Date().toISOString()}`,
    status: 'active',
    startTime: new Date().toISOString(),
    monitoring: {
      console: params.monitorConsole ?? true,
      network: params.monitorNetwork ?? true,
      screenshots: params.takeScreenshots ?? false,
      screenshotInterval: params.screenshotInterval ?? 10
    },
    localPort: params.localPort,
    isLocalhost: params.isLocalhost,
    tunnelId: params.tunnelId
  };
}

export const mockBrowserSessionsService = {
  async startSession(params: any): Promise<MockBrowserSession> {
    if (!params.url) {
      throw new Error('URL is required');
    }
    
    // Simulate validation
    if (params.url === '') {
      throw new Error('Invalid URL: URL cannot be empty');
    }
    
    const session = createMockSession(params);
    mockSessions.set(session.sessionId, session);
    
    return session;
  },

  async stopSession(sessionId: string): Promise<{ session: MockBrowserSession; summary: any }> {
    const session = mockSessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    
    session.status = 'stopped';
    session.endTime = new Date().toISOString();
    
    const summary = {
      duration: Date.now() - new Date(session.startTime).getTime(),
      totalPageLoads: Math.floor(Math.random() * 10),
      totalConsoleMessages: Math.floor(Math.random() * 50),
      totalNetworkRequests: Math.floor(Math.random() * 100)
    };
    
    return { session, summary };
  },

  async getSessionStatus(sessionId: string): Promise<{ session: MockBrowserSession; stats: MockSessionStats }> {
    const session = mockSessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    
    const uptime = Date.now() - new Date(session.startTime).getTime();
    const stats: MockSessionStats = {
      uptime,
      pageLoads: Math.floor(Math.random() * 10),
      consoleMessages: Math.floor(Math.random() * 50),
      networkRequests: Math.floor(Math.random() * 100),
      screenshotsCaptured: Math.floor(Math.random() * 20)
    };
    
    return { session, stats };
  },

  async listSessions(filters?: { status?: string }): Promise<{ results: MockBrowserSession[] }> {
    let sessions = Array.from(mockSessions.values());
    
    if (filters?.status) {
      sessions = sessions.filter(s => s.status === filters.status);
    }
    
    return { results: sessions };
  },

  async getSessionLogs(sessionId: string, params: any): Promise<MockSessionLogs> {
    const session = mockSessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    
    // Generate mock logs
    const logs = [];
    const logCount = Math.min(params.limit || 100, 20);
    
    for (let i = 0; i < logCount; i++) {
      const logTypes = ['console', 'network', 'error'];
      const type = logTypes[Math.floor(Math.random() * logTypes.length)] as 'console' | 'network' | 'error';
      
      logs.push({
        timestamp: new Date(Date.now() - (i * 1000)).toISOString(),
        type,
        level: type === 'error' ? 'error' : 'log' as 'log' | 'warn' | 'error' | 'info',
        message: `Mock ${type} message ${i}`,
        data: type === 'network' ? { url: `/api/endpoint-${i}`, method: 'GET', status: 200 } : undefined
      });
    }
    
    return {
      sessionId,
      logs,
      filters: {
        logType: params.logType || 'all',
        since: params.since,
        limit: params.limit || 100
      },
      stats: {
        total: logs.length,
        console: logs.filter(l => l.type === 'console').length,
        network: logs.filter(l => l.type === 'network').length,
        errors: logs.filter(l => l.type === 'error').length
      }
    };
  },

  async captureScreenshot(sessionId: string, params: any): Promise<MockScreenshot> {
    const session = mockSessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    
    if (session.status !== 'active') {
      throw new Error('Cannot take screenshot: session is stopped');
    }
    
    // Generate mock base64 image data (tiny 1x1 PNG)
    const mockImageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    
    return {
      sessionId,
      screenshot: {
        data: mockImageData,
        format: params.format || 'png',
        quality: params.quality || 90,
        fullPage: params.fullPage || false,
        size: {
          width: params.fullPage ? 1920 : 1024,
          height: params.fullPage ? 3000 : 768
        },
        timestamp: new Date().toISOString()
      }
    };
  }
};

export const createMockDebuggAIClient = () => ({
  async init() {
    // Mock initialization
  },
  
  browserSessions: mockBrowserSessionsService,
  
  // Mock other services as needed
  e2es: null,
  testSuites: null,
  commitSuites: null
});

// Helper function to clear mock state between tests
export function clearMockSessions() {
  mockSessions.clear();
  sessionIdCounter = 1000;
}