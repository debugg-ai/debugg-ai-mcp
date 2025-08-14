/**
 * Tests for Live Session Handlers
 */

import { 
  startLiveSessionHandler,
  stopLiveSessionHandler,
  getLiveSessionStatusHandler,
  getLiveSessionLogsHandler,
  getLiveSessionScreenshotHandler
} from '../../handlers/liveSessionHandlers.js';
import { ToolContext } from '../../types/index.js';

describe('Live Session Handlers', () => {
  const mockProgressCallback = {
    calls: [] as any[],
    async mockImplementation(...args: any[]) { 
      this.calls.push(args);
    },
    mockClear() {
      this.calls = [];
    }
  };
  
  beforeEach(() => {
    mockProgressCallback.mockClear();
  });

  const mockContext: ToolContext = {
    requestId: 'test-123',
    timestamp: new Date()
  };

  let testSessionId: string;

  describe('Start Live Session Handler', () => {
    test('should start a live session', async () => {
      const input = {
        url: 'http://localhost:3000',
        sessionName: 'Test Session',
        monitorConsole: true,
        monitorNetwork: true,
        takeScreenshots: false
      };

      const result = await startLiveSessionHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');

      const sessionResult = JSON.parse(result.content[0].text);
      expect(sessionResult.success).toBe(true);
      expect(sessionResult.session).toBeDefined();
      expect(sessionResult.session.sessionId).toBeDefined();
      expect(sessionResult.session.url).toBe(input.url);
      expect(sessionResult.session.sessionName).toBe(input.sessionName);
      expect(sessionResult.session.status).toBe('active');

      // Store session ID for other tests
      testSessionId = sessionResult.session.sessionId;

      // Should have called progress callback
      expect(mockProgressCallback.calls.length).toBeGreaterThan(0);
    }, 15000);

    test('should start session with minimal parameters', async () => {
      const input = {
        url: 'http://localhost:3001'
      };

      const result = await startLiveSessionHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      const sessionResult = JSON.parse(result.content[0].text);
      expect(sessionResult.success).toBe(true);
      expect(sessionResult.session.url).toBe(input.url);
      expect(sessionResult.session.monitoring.console).toBe(true); // default
      expect(sessionResult.session.monitoring.network).toBe(true); // default
      expect(sessionResult.session.monitoring.screenshots).toBe(false); // default
    }, 15000);

    test('should start session with screenshot monitoring', async () => {
      const input = {
        url: 'http://localhost:3002',
        takeScreenshots: true,
        screenshotInterval: 5
      };

      const result = await startLiveSessionHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      const sessionResult = JSON.parse(result.content[0].text);
      expect(sessionResult.success).toBe(true);
      expect(sessionResult.session.monitoring.screenshots).toBe(true);
      expect(sessionResult.session.monitoring.screenshotInterval).toBe(5);
    }, 15000);
  });

  describe('Get Live Session Status Handler', () => {
    test('should get status of existing session', async () => {
      // First start a session
      const startInput = {
        url: 'http://localhost:3003',
        sessionName: 'Status Test Session'
      };
      
      const startResult = await startLiveSessionHandler(startInput, mockContext);
      const startSession = JSON.parse(startResult.content[0].text);
      const sessionId = startSession.session.sessionId;

      // Now get the status
      const statusInput = {
        sessionId: sessionId
      };

      const result = await getLiveSessionStatusHandler(statusInput, mockContext);

      expect(result).toBeDefined();
      const statusResult = JSON.parse(result.content[0].text);
      expect(statusResult.success).toBe(true);
      expect(statusResult.session).toBeDefined();
      expect(statusResult.session.sessionId).toBe(sessionId);
      expect(statusResult.session.status).toBe('active');
      expect(statusResult.session.stats).toBeDefined();
      expect(statusResult.session.stats.uptime).toBeGreaterThanOrEqual(0);
    }, 15000);

    test('should handle no active session', async () => {
      const input = {};

      const result = await getLiveSessionStatusHandler(input, mockContext);

      expect(result).toBeDefined();
      const statusResult = JSON.parse(result.content[0].text);
      expect(statusResult.success).toBe(true);
      expect(statusResult.currentSession).toBeNull();
      expect(statusResult.activeSessions).toBeDefined();
    }, 10000);

    test('should handle non-existent session', async () => {
      const input = {
        sessionId: 'non-existent-session-id'
      };

      await expect(
        getLiveSessionStatusHandler(input, mockContext)
      ).rejects.toThrow('Session not found');
    }, 10000);
  });

  describe('Get Live Session Logs Handler', () => {
    test('should get logs from existing session', async () => {
      // First start a session
      const startInput = {
        url: 'http://localhost:3004',
        sessionName: 'Logs Test Session'
      };
      
      const startResult = await startLiveSessionHandler(startInput, mockContext);
      const startSession = JSON.parse(startResult.content[0].text);
      const sessionId = startSession.session.sessionId;

      // Get logs
      const logsInput = {
        sessionId: sessionId,
        logType: 'all' as const,
        limit: 50
      };

      const result = await getLiveSessionLogsHandler(logsInput, mockContext);

      expect(result).toBeDefined();
      const logsResult = JSON.parse(result.content[0].text);
      expect(logsResult.success).toBe(true);
      expect(logsResult.session.sessionId).toBe(sessionId);
      expect(logsResult.logs).toBeDefined();
      expect(Array.isArray(logsResult.logs)).toBe(true);
      expect(logsResult.filters.limit).toBe(50);
      expect(logsResult.stats).toBeDefined();
    }, 15000);

    test('should filter logs by type', async () => {
      // Start a session first
      const startInput = { url: 'http://localhost:3005' };
      const startResult = await startLiveSessionHandler(startInput, mockContext);
      const sessionId = JSON.parse(startResult.content[0].text).session.sessionId;

      const logsInput = {
        sessionId: sessionId,
        logType: 'console' as const
      };

      const result = await getLiveSessionLogsHandler(logsInput, mockContext);

      expect(result).toBeDefined();
      const logsResult = JSON.parse(result.content[0].text);
      expect(logsResult.success).toBe(true);
      expect(logsResult.filters.logType).toBe('console');
    }, 15000);

    test('should handle session not found', async () => {
      const input = {
        sessionId: 'non-existent-session'
      };

      await expect(
        getLiveSessionLogsHandler(input, mockContext)
      ).rejects.toThrow('Session not found');
    }, 10000);
  });

  describe('Get Live Session Screenshot Handler', () => {
    test('should capture screenshot from active session', async () => {
      // Start a session first
      const startInput = {
        url: 'http://localhost:3006',
        sessionName: 'Screenshot Test Session'
      };
      
      const startResult = await startLiveSessionHandler(startInput, mockContext);
      const startSession = JSON.parse(startResult.content[0].text);
      const sessionId = startSession.session.sessionId;

      // Capture screenshot
      const screenshotInput = {
        sessionId: sessionId,
        fullPage: false,
        quality: 85,
        format: 'png' as const
      };

      const result = await getLiveSessionScreenshotHandler(screenshotInput, mockContext);

      expect(result).toBeDefined();
      const screenshotResult = JSON.parse(result.content[0].text);
      expect(screenshotResult.success).toBe(true);
      expect(screenshotResult.session.sessionId).toBe(sessionId);
      expect(screenshotResult.screenshot).toBeDefined();
      expect(screenshotResult.screenshot.format).toBe('png');
      expect(screenshotResult.screenshot.quality).toBe(85);
      expect(screenshotResult.screenshot.fullPage).toBe(false);
      expect(screenshotResult.screenshot.data).toBeDefined();
      expect(screenshotResult.screenshot.size).toBeDefined();
    }, 15000);

    test('should capture full page screenshot', async () => {
      // Start a session first
      const startInput = { url: 'http://localhost:3007' };
      const startResult = await startLiveSessionHandler(startInput, mockContext);
      const sessionId = JSON.parse(startResult.content[0].text).session.sessionId;

      const screenshotInput = {
        sessionId: sessionId,
        fullPage: true,
        format: 'jpeg' as const,
        quality: 90
      };

      const result = await getLiveSessionScreenshotHandler(screenshotInput, mockContext);

      expect(result).toBeDefined();
      const screenshotResult = JSON.parse(result.content[0].text);
      expect(screenshotResult.screenshot.fullPage).toBe(true);
      expect(screenshotResult.screenshot.format).toBe('jpeg');
      expect(screenshotResult.screenshot.quality).toBe(90);
    }, 15000);

    test('should handle inactive session', async () => {
      // Start and stop a session
      const startInput = { url: 'http://localhost:3008' };
      const startResult = await startLiveSessionHandler(startInput, mockContext);
      const sessionId = JSON.parse(startResult.content[0].text).session.sessionId;
      
      await stopLiveSessionHandler({ sessionId }, mockContext);

      // Try to take screenshot from stopped session
      const screenshotInput = { sessionId };

      await expect(
        getLiveSessionScreenshotHandler(screenshotInput, mockContext)
      ).rejects.toThrow('Cannot take screenshot: session is stopped');
    }, 15000);
  });

  describe('Stop Live Session Handler', () => {
    test('should stop an active session', async () => {
      // Start a session first
      const startInput = {
        url: 'http://localhost:3009',
        sessionName: 'Stop Test Session'
      };
      
      const startResult = await startLiveSessionHandler(startInput, mockContext);
      const startSession = JSON.parse(startResult.content[0].text);
      const sessionId = startSession.session.sessionId;

      // Stop the session
      const stopInput = {
        sessionId: sessionId
      };

      const result = await stopLiveSessionHandler(stopInput, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      const stopResult = JSON.parse(result.content[0].text);
      expect(stopResult.success).toBe(true);
      expect(stopResult.session.sessionId).toBe(sessionId);
      expect(stopResult.session.status).toBe('stopped');
      expect(stopResult.session.endTime).toBeDefined();

      // Should have called progress callback
      expect(mockProgressCallback.calls.length).toBeGreaterThan(0);
    }, 15000);

    test('should handle stopping non-existent session', async () => {
      const input = {
        sessionId: 'non-existent-session'
      };

      await expect(
        stopLiveSessionHandler(input, mockContext)
      ).rejects.toThrow('Session not found');
    }, 10000);

    test('should handle no session ID provided when no current session', async () => {
      const input = {};

      await expect(
        stopLiveSessionHandler(input, mockContext)
      ).rejects.toThrow('No session ID provided and no current session active');
    }, 10000);
  });

  describe('Error Handling', () => {
    test('should handle invalid URL in start session', async () => {
      const input = {
        url: '' // Invalid empty URL
      };

      // Should throw validation error
      await expect(
        startLiveSessionHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback))
      ).rejects.toThrow();
    }, 10000);
  });
});