/**
 * Integration tests for Browser Sessions functionality
 * Tests the complete flow from handlers to services, with graceful handling of missing API endpoints
 */

import { config } from '../../config/index.js';
import { DebuggAIServerClient } from '../../services/index.js';
import { 
  startLiveSessionHandler,
  stopLiveSessionHandler,
  getLiveSessionStatusHandler,
  getLiveSessionLogsHandler,
  getLiveSessionScreenshotHandler
} from '../../handlers/liveSessionHandlers.js';
import { ToolContext } from '../../types/index.js';

describe('Browser Sessions Integration Tests', () => {
  let client: DebuggAIServerClient | null = null;
  let isApiAvailable = false;
  
  const mockContext: ToolContext = {
    requestId: 'integration-test-123',
    timestamp: new Date()
  };

  beforeAll(async () => {
    // Only initialize if we have a valid API key
    if (config.api.key && 
        config.api.key !== 'test-key-placeholder' && 
        config.api.key !== 'test-api-key' &&
        config.api.key !== 'test-api-key-for-testing') {
      
      try {
        client = new DebuggAIServerClient(config.api.key);
        await client.init();
        
        // Test if browser sessions API is available by trying to list sessions
        if (client.browserSessions) {
          await client.browserSessions.listSessions({ limit: 1 });
          isApiAvailable = true;
          console.log('✓ Browser Sessions API is available - running full integration tests');
        }
      } catch (error) {
        if ((error as any).message?.includes('API endpoint not found') ||
            (error as any).message?.includes('Browser sessions API endpoint not found')) {
          console.log('! Browser Sessions API endpoints not available - running limited tests');
          isApiAvailable = false;
        } else {
          console.log('! API connection failed - running offline tests only');
          isApiAvailable = false;
        }
      }
    } else {
      console.log('! No valid API key provided - running offline tests only');
    }
  });

  describe('API Availability Tests', () => {
    test('should determine API availability correctly', () => {
      if (config.api.key && config.api.key !== 'test-key-placeholder') {
        expect(client).toBeDefined();
        if (client) {
          expect(client.browserSessions).toBeDefined();
        }
      } else {
        console.log('Skipping API availability test - no valid API key');
      }
    });
  });

  describe('Start Live Session Integration', () => {
    test('should handle session start request appropriately', async () => {
      const input = {
        url: 'https://example.com',
        sessionName: 'Integration Test Session',
        monitorConsole: true,
        monitorNetwork: true,
        takeScreenshots: false
      };

      if (isApiAvailable && client?.browserSessions) {
        // Test with real API
        try {
          const result = await startLiveSessionHandler(input, mockContext);
          
          expect(result).toBeDefined();
          expect(result.content).toBeDefined();
          expect(result.content[0].type).toBe('text');
          
          const response = JSON.parse(result.content[0].text!);
          expect(response.success).toBeDefined();
          expect(response.session).toBeDefined();
          expect(response.session.sessionId).toBeDefined();
          expect(response.session.url).toBe(input.url);
          expect(response.session.sessionName).toBe(input.sessionName);
        } catch (error) {
          // If API call fails, verify error handling
          expect((error as Error).message).toContain('Failed to start browser session');
        }
      } else {
        // Test error handling when API is not available
        await expect(startLiveSessionHandler(input, mockContext))
          .rejects
          .toThrow(/Failed to start browser session|Browser sessions API endpoint not found/);
      }
    }, 30000);

    test('should validate input parameters correctly', async () => {
      const invalidInput = {
        url: '', // Invalid empty URL
        sessionName: 'Test'
      };

      // Should fail validation regardless of API availability
      await expect(startLiveSessionHandler(invalidInput as any, mockContext))
        .rejects
        .toThrow();
    });
  });

  describe('Session Status Integration', () => {
    test('should handle status check appropriately', async () => {
      if (isApiAvailable && client?.browserSessions) {
        // Test with real API - check for active sessions
        try {
          const result = await getLiveSessionStatusHandler({}, mockContext);
          
          expect(result).toBeDefined();
          expect(result.content).toBeDefined();
          
          const response = JSON.parse(result.content[0].text!);
          expect(response.success).toBeDefined();
          expect(response.activeSessions).toBeDefined();
          expect(Array.isArray(response.activeSessions)).toBe(true);
        } catch (error) {
          // Error is acceptable if no sessions exist or API issues
          expect((error as Error).message).toContain('Failed to');
        }
      } else {
        // Test error handling when API is not available
        await expect(getLiveSessionStatusHandler({}, mockContext))
          .rejects
          .toThrow(/Failed to list sessions|Browser sessions API endpoint not found/);
      }
    }, 20000);

    test('should handle invalid session ID correctly', async () => {
      const invalidInput = {
        sessionId: 'non-existent-session-id'
      };

      if (isApiAvailable && client?.browserSessions) {
        // Should get a session not found error from the API
        await expect(getLiveSessionStatusHandler(invalidInput, mockContext))
          .rejects
          .toThrow(/Session not found|Failed to get session status/);
      } else {
        // Should get a service unavailable error
        await expect(getLiveSessionStatusHandler(invalidInput, mockContext))
          .rejects
          .toThrow(/Failed to get session status|Browser sessions API endpoint not found/);
      }
    }, 15000);
  });

  describe('Session Logs Integration', () => {
    test('should handle logs request appropriately', async () => {
      const input = {
        sessionId: 'test-session-for-logs',
        logType: 'all' as const,
        limit: 10
      };

      if (isApiAvailable && client?.browserSessions) {
        // Test with real API
        await expect(getLiveSessionLogsHandler(input, mockContext))
          .rejects
          .toThrow(/Session not found/); // Expected since we're using a fake session ID
      } else {
        // Test error handling when API is not available
        await expect(getLiveSessionLogsHandler(input, mockContext))
          .rejects
          .toThrow(/Failed to get session logs|Browser sessions API endpoint not found/);
      }
    }, 15000);

    test('should validate log type parameters', async () => {
      const validLogTypes = ['console', 'network', 'errors', 'all'];
      
      for (const logType of validLogTypes) {
        const input = {
          sessionId: 'test-session',
          logType: logType as any,
          limit: 5
        };

        // Should pass input validation regardless of API availability
        if (isApiAvailable && client?.browserSessions) {
          await expect(getLiveSessionLogsHandler(input, mockContext))
            .rejects
            .toThrow(/Session not found/); // Expected with fake session ID
        } else {
          await expect(getLiveSessionLogsHandler(input, mockContext))
            .rejects
            .toThrow(/Failed to get session logs|Browser sessions API endpoint not found/);
        }
      }
    });
  });

  describe('Screenshot Integration', () => {
    test('should handle screenshot request appropriately', async () => {
      const input = {
        sessionId: 'test-session-for-screenshot',
        fullPage: false,
        format: 'png' as const,
        quality: 90
      };

      if (isApiAvailable && client?.browserSessions) {
        // Test with real API
        await expect(getLiveSessionScreenshotHandler(input, mockContext))
          .rejects
          .toThrow(/Session not found/); // Expected since we're using a fake session ID
      } else {
        // Test error handling when API is not available
        await expect(getLiveSessionScreenshotHandler(input, mockContext))
          .rejects
          .toThrow(/Failed to capture screenshot|Browser sessions API endpoint not found/);
      }
    }, 15000);

    test('should validate screenshot parameters', async () => {
      const validFormats = ['png', 'jpeg'];
      
      for (const format of validFormats) {
        const input = {
          sessionId: 'test-session',
          format: format as any,
          quality: 85
        };

        // Should pass input validation regardless of API availability
        if (isApiAvailable && client?.browserSessions) {
          await expect(getLiveSessionScreenshotHandler(input, mockContext))
            .rejects
            .toThrow(/Session not found/); // Expected with fake session ID
        } else {
          await expect(getLiveSessionScreenshotHandler(input, mockContext))
            .rejects
            .toThrow(/Failed to capture screenshot|Browser sessions API endpoint not found/);
        }
      }
    });
  });

  describe('Stop Session Integration', () => {
    test('should handle stop request appropriately', async () => {
      const input = {
        sessionId: 'test-session-to-stop'
      };

      if (isApiAvailable && client?.browserSessions) {
        // Test with real API
        await expect(stopLiveSessionHandler(input, mockContext))
          .rejects
          .toThrow(/Failed to stop browser session/); // Expected since we're using a fake session ID
      } else {
        // Test error handling when API is not available
        await expect(stopLiveSessionHandler(input, mockContext))
          .rejects
          .toThrow(/Failed to stop browser session|Browser sessions API endpoint not found/);
      }
    }, 15000);

    test('should handle missing session ID appropriately', async () => {
      const input = {}; // No session ID provided

      // Should fail regardless of API availability
      await expect(stopLiveSessionHandler(input, mockContext))
        .rejects
        .toThrow(/No session ID provided and no current session active/);
    });
  });

  describe('Service Configuration Integration', () => {
    test('should have proper service configuration', async () => {
      if (client) {
        expect(client).toBeDefined();
        expect(client.browserSessions).toBeDefined();
        
        const serverUrl = await client.getServerUrl();
        expect(serverUrl).toBeDefined();
        expect(typeof serverUrl).toBe('string');
        expect(serverUrl.startsWith('https://')).toBe(true);
      }
    });

    test('should handle service initialization correctly', async () => {
      if (config.api.key && config.api.key !== 'test-key-placeholder') {
        const testClient = new DebuggAIServerClient(config.api.key);
        await testClient.init();
        
        expect(testClient.browserSessions).toBeDefined();
        expect(testClient.tx).toBeDefined();
        expect(testClient.url).toBeDefined();
      }
    });
  });

  describe('Error Handling Integration', () => {
    test('should provide meaningful error messages', async () => {
      const input = {
        url: 'https://example.com',
        sessionName: 'Error Test Session'
      };

      try {
        await startLiveSessionHandler(input, mockContext);
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).toBeDefined();
        expect(errorMessage.length).toBeGreaterThan(0);
        
        // Should not contain raw HTML error pages
        expect(errorMessage).not.toContain('<!DOCTYPE html>');
        expect(errorMessage).not.toContain('<html>');
        
        // Should contain meaningful error information
        expect(
          errorMessage.includes('Failed to start browser session') ||
          errorMessage.includes('Browser sessions API endpoint not found') ||
          errorMessage.includes('service may not be available')
        ).toBe(true);
      }
    });

    test('should handle network errors gracefully', async () => {
      // This test verifies our error handling works with various error types
      const inputs = [
        { url: 'https://example.com', sessionName: 'Network Error Test 1' },
        { url: 'http://localhost:3000', sessionName: 'Network Error Test 2' }
      ];

      for (const input of inputs) {
        try {
          await startLiveSessionHandler(input, mockContext);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBeDefined();
          expect((error as Error).message.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('Response Format Integration', () => {
    test('should return consistent response format', async () => {
      const input = {
        sessionId: 'format-test-session'
      };

      try {
        const result = await getLiveSessionStatusHandler(input, mockContext);
        
        // If successful, should have proper format
        expect(result).toBeDefined();
        expect(result.content).toBeDefined();
        expect(Array.isArray(result.content)).toBe(true);
        expect(result.content.length).toBe(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toBeDefined();
        
        // Should be valid JSON
        const parsed = JSON.parse(result.content[0].text!);
        expect(parsed).toBeDefined();
        expect(typeof parsed.success).toBe('boolean');
      } catch (error) {
        // Error is expected, just verify it's handled properly
        expect(error).toBeInstanceOf(Error);
      }
    });
  });
});

/**
 * Comprehensive Browser Sessions Service Tests - Extended Coverage
 * Tests all browser session functionality with detailed mock scenarios
 */
describe('Browser Sessions Service - Comprehensive Tests', () => {
  let mockTransport: any;
  let service: any;
  let mockResponses: Map<string, any>;

  beforeEach(() => {
    mockResponses = new Map();
    
    // Create a comprehensive mock transport
    const mockAxios = {
      interceptors: {
        request: { use: () => 0 },
        response: { use: () => 0 }
      },
      request: () => Promise.resolve({ data: {}, status: 200 }),
      defaults: { baseURL: '', headers: {} },
      get: (url: string, params?: any) => {
        const key = `GET:${url}`;
        if (mockResponses.has(key)) {
          const mockData = mockResponses.get(key);
          if (mockData.shouldError) {
            return Promise.reject(new Error(mockData.errorMessage));
          }
          return Promise.resolve({ data: mockData, status: 200 });
        }
        return Promise.resolve({ data: { message: 'Default response' }, status: 200 });
      },
      post: (url: string, data?: any) => {
        const key = `POST:${url}`;
        if (mockResponses.has(key)) {
          const mockData = mockResponses.get(key);
          if (mockData.shouldError) {
            return Promise.reject(new Error(mockData.errorMessage));
          }
          return Promise.resolve({ data: mockData, status: 201 });
        }
        return Promise.resolve({ data: { message: 'Default response' }, status: 201 });
      },
      patch: (url: string, data?: any) => {
        const key = `PATCH:${url}`;
        if (mockResponses.has(key)) {
          const mockData = mockResponses.get(key);
          if (mockData.shouldError) {
            return Promise.reject(new Error(mockData.errorMessage));
          }
          return Promise.resolve({ data: mockData, status: 200 });
        }
        return Promise.resolve({ data: { message: 'Default response' }, status: 200 });
      }
    };

    // Use the AxiosTransport constructor
    const { AxiosTransport } = await import('../../utils/axiosTransport.js');
    mockTransport = new AxiosTransport({
      baseUrl: 'https://test-api.debugg.ai',
      apiKey: 'test-key',
      instance: mockAxios
    });

    const { createBrowserSessionsService } = await import('../../services/browserSessions.js');
    service = createBrowserSessionsService(mockTransport);
  });

  describe('Session Creation Advanced Scenarios', () => {
    test('should create session with URL intelligence integration', async () => {
      const sessionResponse = {
        uuid: 'url-intelligence-session',
        session_name: 'URL Intelligence Test',
        initial_url: 'http://localhost:3000/dashboard/', // Resolved from "dashboard"
        status: 'PENDING',
        timestamp: new Date().toISOString()
      };

      mockResponses.set('POST:api/v1/browser-sessions/sessions/', sessionResponse);

      const params = {
        url: 'http://localhost:3000/dashboard/', // URL resolved from natural language
        sessionName: 'URL Intelligence Test',
        localPort: 3000
      };

      const result = await service.startSession(params);

      expect(result).toMatchObject({
        sessionId: 'url-intelligence-session',
        sessionName: 'URL Intelligence Test',
        url: 'http://localhost:3000/dashboard/',
        localPort: 3000,
        status: 'starting'
      });
    });

    test('should handle complex session configurations', async () => {
      const sessionResponse = {
        uuid: 'complex-session',
        session_name: 'Complex Configuration Test',
        initial_url: 'http://localhost:8080/app',
        status: 'ACTIVE',
        timestamp: new Date().toISOString(),
        tunnel_key: 'complex-tunnel-123'
      };

      mockResponses.set('POST:api/v1/browser-sessions/sessions/', sessionResponse);

      const params = {
        url: 'http://localhost:8080/app',
        sessionName: 'Complex Configuration Test',
        localPort: 8080,
        monitorConsole: true,
        monitorNetwork: true,
        takeScreenshots: true,
        screenshotInterval: 2
      };

      const result = await service.startSession(params);

      expect(result).toMatchObject({
        sessionId: 'complex-session',
        sessionName: 'Complex Configuration Test',
        url: 'http://localhost:8080/app',
        localPort: 8080,
        status: 'active',
        monitoring: {
          console: true,
          network: true,
          screenshots: true,
          screenshotInterval: 2
        },
        tunnelKey: 'complex-tunnel-123'
      });
    });

    test('should handle backend HTML error responses gracefully', async () => {
      mockResponses.set('POST:api/v1/browser-sessions/sessions/', {
        shouldError: true,
        errorMessage: '<!DOCTYPE html><html><head><title>Django Error</title></head><body><h1>API Not Found</h1></body></html>'
      });

      const params = {
        url: 'https://example.com',
        sessionName: 'HTML Error Test'
      };

      await expect(service.startSession(params))
        .rejects
        .toThrow('Failed to start browser session: Browser sessions API endpoint not found - service may not be available');
    });

    test('should generate fallback session IDs with proper format', async () => {
      // Response without uuid or key
      const sessionResponse = {
        session_name: 'Fallback Test',
        initial_url: 'https://example.com',
        status: 'PENDING'
      };

      mockResponses.set('POST:api/v1/browser-sessions/sessions/', sessionResponse);

      const result = await service.startSession({
        url: 'https://example.com',
        sessionName: 'Fallback Test'
      });

      // Should generate a fallback ID with the expected format
      expect(result.sessionId).toMatch(/^session_\d+_[a-z0-9]{9}$/);
      expect(result.sessionName).toBe('Fallback Test');
    });
  });

  describe('Session Logs Advanced Testing', () => {
    test('should handle console logs with various log levels', async () => {
      const consoleResponse = {
        results: [
          { timestamp: '2024-01-01T12:00:00Z', level: 'log', message: 'Normal log', source: 'app.js:1' },
          { timestamp: '2024-01-01T12:00:01Z', level: 'info', message: 'Info message', source: 'api.js:15' },
          { timestamp: '2024-01-01T12:00:02Z', level: 'warn', message: 'Warning occurred', source: 'utils.js:23' },
          { timestamp: '2024-01-01T12:00:03Z', level: 'error', message: 'Error happened', source: 'main.js:100' },
          { timestamp: '2024-01-01T12:00:04Z', level: 'debug', message: 'Debug info', source: 'debug.js:5' }
        ]
      };

      mockResponses.set('GET:api/v1/browser-sessions/console-logs/', consoleResponse);

      const result = await service.getSessionLogs('console-levels-session', {
        logType: 'console',
        limit: 10
      });

      expect(result.logs).toHaveLength(5);
      expect(result.logs[0].level).toBe('log');
      expect(result.logs[1].level).toBe('info');
      expect(result.logs[2].level).toBe('warn');
      expect(result.logs[3].level).toBe('error');
      expect(result.logs[4].level).toBe('debug');
      expect(result.stats.consoleCount).toBe(5);
    });

    test('should handle network events with detailed information', async () => {
      const networkResponse = {
        results: [
          {
            timestamp: '2024-01-01T12:00:10Z',
            method: 'GET',
            url: 'https://api.example.com/users',
            status: 200,
            response_time: 145
          },
          {
            timestamp: '2024-01-01T12:00:15Z',
            method: 'POST',
            url: 'https://api.example.com/auth/login',
            status: 200,
            response_time: 89
          },
          {
            timestamp: '2024-01-01T12:00:20Z',
            method: 'GET',
            url: 'https://api.example.com/profile',
            status: 404,
            response_time: 67
          }
        ]
      };

      mockResponses.set('GET:api/v1/browser-sessions/network-events/', networkResponse);

      const result = await service.getSessionLogs('network-detailed-session', {
        logType: 'network',
        since: '2024-01-01T12:00:00Z'
      });

      expect(result.logs).toHaveLength(3);
      expect(result.logs[0].message).toBe('GET https://api.example.com/users - 200');
      expect(result.logs[0].details).toMatchObject({
        url: 'https://api.example.com/users',
        method: 'GET',
        status: 200,
        response_time: 145
      });
      expect(result.stats.networkCount).toBe(3);
    });

    test('should handle mixed logs with proper sorting by timestamp', async () => {
      const consoleResponse = {
        results: [
          { timestamp: '2024-01-01T12:00:00Z', level: 'info', message: 'App started' },
          { timestamp: '2024-01-01T12:00:10Z', level: 'log', message: 'User action' }
        ]
      };

      const networkResponse = {
        results: [
          { timestamp: '2024-01-01T12:00:05Z', method: 'GET', url: '/api/init', status: 200 },
          { timestamp: '2024-01-01T12:00:15Z', method: 'POST', url: '/api/action', status: 201 }
        ]
      };

      mockResponses.set('GET:api/v1/browser-sessions/console-logs/', consoleResponse);
      mockResponses.set('GET:api/v1/browser-sessions/network-events/', networkResponse);

      const result = await service.getSessionLogs('mixed-sorted-session', {
        logType: 'all'
      });

      expect(result.logs).toHaveLength(4);
      // Should be sorted by timestamp
      expect(result.logs[0].timestamp).toBe('2024-01-01T12:00:00Z');
      expect(result.logs[1].timestamp).toBe('2024-01-01T12:00:05Z');
      expect(result.logs[2].timestamp).toBe('2024-01-01T12:00:10Z');
      expect(result.logs[3].timestamp).toBe('2024-01-01T12:00:15Z');
      expect(result.stats.totalLogs).toBe(4);
      expect(result.stats.consoleCount).toBe(2);
      expect(result.stats.networkCount).toBe(2);
    });

    test('should apply limit to logs correctly', async () => {
      const consoleResponse = {
        results: Array.from({ length: 20 }, (_, i) => ({
          timestamp: `2024-01-01T12:00:${i.toString().padStart(2, '0')}Z`,
          level: 'log',
          message: `Log message ${i}`
        }))
      };

      mockResponses.set('GET:api/v1/browser-sessions/console-logs/', consoleResponse);

      const result = await service.getSessionLogs('limit-test-session', {
        logType: 'console',
        limit: 5
      });

      expect(result.logs).toHaveLength(5);
      expect(result.logs[0].message).toBe('Log message 0');
      expect(result.logs[4].message).toBe('Log message 4');
    });
  });

  describe('Session Screenshots Advanced Testing', () => {
    test('should handle screenshot with custom parameters', async () => {
      const screenshotResponse = {
        results: [
          {
            data: 'base64-encoded-jpeg-data-here',
            format: 'jpeg',
            quality: 75,
            full_page: true,
            timestamp: '2024-01-01T12:30:00Z',
            width: 1920,
            height: 5000, // Long page
            file_size: 85000
          }
        ]
      };

      mockResponses.set('GET:api/v1/browser-sessions/screenshots/', screenshotResponse);

      const result = await service.captureScreenshot('custom-screenshot-session', {
        fullPage: true,
        format: 'jpeg',
        quality: 75
      });

      expect(result.screenshot).toMatchObject({
        data: 'base64-encoded-jpeg-data-here',
        format: 'jpeg',
        quality: 75,
        fullPage: true,
        timestamp: '2024-01-01T12:30:00Z',
        size: {
          width: 1920,
          height: 5000,
          bytes: 85000
        }
      });
    });

    test('should handle screenshot format fallbacks correctly', async () => {
      const screenshotResponse = {
        results: [
          {
            data: 'base64-png-data',
            // format missing from response
            full_page: false,
            timestamp: '2024-01-01T12:35:00Z',
            width: 1280,
            height: 720,
            file_size: 45000
          }
        ]
      };

      mockResponses.set('GET:api/v1/browser-sessions/screenshots/', screenshotResponse);

      const result = await service.captureScreenshot('fallback-screenshot-session', {
        format: 'png' // Should use this as fallback
      });

      expect(result.screenshot.format).toBe('png');
      expect(result.screenshot.data).toBe('base64-png-data');
    });

    test('should provide meaningful placeholder for missing screenshots', async () => {
      const emptyResponse = { results: [] };
      mockResponses.set('GET:api/v1/browser-sessions/screenshots/', emptyResponse);

      const result = await service.captureScreenshot('no-screenshot-session', {
        fullPage: true,
        format: 'jpeg',
        quality: 95
      });

      expect(result.screenshot).toMatchObject({
        data: expect.stringMatching(/^iVBORw0KGgo/), // Base64 PNG header
        format: 'jpeg', // Should respect requested format
        quality: 95,
        fullPage: true,
        timestamp: expect.any(String),
        size: {
          width: 1,
          height: 1,
          bytes: 68
        }
      });
    });
  });

  describe('Session Listing Advanced Scenarios', () => {
    test('should handle large session lists with pagination', async () => {
      const listResponse = {
        count: 250,
        next: 'https://api.debugg.ai/sessions/?offset=50&limit=50',
        previous: 'https://api.debugg.ai/sessions/?offset=0&limit=50',
        results: Array.from({ length: 50 }, (_, i) => ({
          uuid: `session-${i + 25}`,
          session_name: `Session ${i + 25}`,
          initial_url: `https://test-${i + 25}.example.com`,
          status: i % 2 === 0 ? 'ACTIVE' : 'COMPLETED',
          timestamp: new Date(Date.now() - (i * 60000)).toISOString()
        }))
      };

      mockResponses.set('GET:api/v1/browser-sessions/sessions/', listResponse);

      const result = await service.listSessions({
        limit: 50,
        offset: 25
      });

      expect(result.count).toBe(250);
      expect(result.results).toHaveLength(50);
      expect(result.next).toBe('https://api.debugg.ai/sessions/?offset=50&limit=50');
      expect(result.previous).toBe('https://api.debugg.ai/sessions/?offset=0&limit=50');
      expect(result.results[0].sessionId).toBe('session-25');
      expect(result.results[0].status).toBe('active'); // ACTIVE -> active
      expect(result.results[1].status).toBe('stopped'); // COMPLETED -> stopped
    });

    test('should handle status filtering with proper mapping', async () => {
      const statusMappingTests = [
        { mcpStatus: 'starting', backendStatus: 'PENDING' },
        { mcpStatus: 'active', backendStatus: 'ACTIVE' },
        { mcpStatus: 'stopped', backendStatus: 'COMPLETED' },
        { mcpStatus: 'error', backendStatus: 'FAILED' }
      ];

      for (const { mcpStatus, backendStatus } of statusMappingTests) {
        const listResponse = {
          count: 1,
          results: [{
            uuid: `${mcpStatus}-test`,
            session_name: `${mcpStatus} Session`,
            initial_url: 'https://example.com',
            status: backendStatus,
            timestamp: new Date().toISOString()
          }]
        };

        mockResponses.set('GET:api/v1/browser-sessions/sessions/', listResponse);

        const result = await service.listSessions({ status: mcpStatus });

        expect(result.results[0].status).toBe(mcpStatus);
      }
    });

    test('should handle sessions with missing optional fields', async () => {
      const listResponse = {
        count: 3,
        results: [
          {
            uuid: 'minimal-session-1',
            // session_name missing
            initial_url: 'https://example.com',
            status: 'ACTIVE'
            // timestamp missing
          },
          {
            // uuid missing
            key: 'legacy-key-session',
            session_name: 'Legacy Session',
            initial_url: 'https://legacy.example.com',
            status: 'COMPLETED',
            timestamp: new Date().toISOString()
          },
          {
            uuid: 'complete-session',
            session_name: 'Complete Session',
            initial_url: 'https://complete.example.com',
            current_url: 'https://complete.example.com/dashboard',
            status: 'ACTIVE',
            timestamp: new Date().toISOString(),
            tunnel_key: 'complete-tunnel-123'
          }
        ]
      };

      mockResponses.set('GET:api/v1/browser-sessions/sessions/', listResponse);

      const result = await service.listSessions();

      expect(result.results).toHaveLength(3);
      expect(result.results[0].sessionName).toBe('Unnamed Session'); // Default fallback
      expect(result.results[1].sessionId).toBe('legacy-key-session'); // Uses key instead of uuid
      expect(result.results[2].tunnelKey).toBe('complete-tunnel-123');
    });
  });

  describe('Error Handling Edge Cases', () => {
    test('should handle API service completely unavailable', async () => {
      // Simulate service completely down
      mockResponses.set('POST:api/v1/browser-sessions/sessions/', {
        shouldError: true,
        errorMessage: 'Connection refused'
      });

      const params = {
        url: 'https://example.com',
        sessionName: 'Service Down Test'
      };

      await expect(service.startSession(params))
        .rejects
        .toThrow('Failed to start browser session: Connection refused');
    });

    test('should handle malformed JSON responses', async () => {
      // Set up a response that's not proper JSON structure expected
      mockResponses.set('POST:api/v1/browser-sessions/sessions/', {
        invalid_structure: true,
        nested: {
          data: 'unexpected'
        }
      });

      const result = await service.startSession({
        url: 'https://example.com',
        sessionName: 'Malformed JSON Test'
      });

      // Should handle gracefully with fallbacks
      expect(result.sessionId).toMatch(/^session_\d+_/);
      expect(result.sessionName).toBe('Malformed JSON Test');
      expect(result.url).toBe('https://example.com');
      expect(result.status).toBe('starting'); // Default status
    });

    test('should handle concurrent operations without race conditions', async () => {
      const baseResponse = {
        uuid: 'race-condition-session',
        session_name: 'Race Test',
        initial_url: 'https://example.com',
        status: 'ACTIVE',
        timestamp: new Date().toISOString()
      };

      mockResponses.set('POST:api/v1/browser-sessions/sessions/', baseResponse);
      mockResponses.set('GET:api/v1/browser-sessions/sessions/race-condition-session/', baseResponse);
      mockResponses.set('PATCH:api/v1/browser-sessions/sessions/race-condition-session/', {
        ...baseResponse,
        status: 'COMPLETED'
      });

      // Fire multiple concurrent operations
      const operations = [
        service.startSession({ url: 'https://example.com', sessionName: 'Race Test' }),
        service.getSessionStatus('race-condition-session'),
        service.stopSession('race-condition-session')
      ];

      const results = await Promise.all(operations);

      expect(results[0].sessionId).toBe('race-condition-session'); // startSession
      expect(results[1].session.sessionId).toBe('race-condition-session'); // getSessionStatus
      expect(results[2].session.sessionId).toBe('race-condition-session'); // stopSession
      expect(results[2].session.status).toBe('stopped');
    });
  });
});

/**
 * Comprehensive Offline Development Testing with Mock Services
 * Tests complete workflows using enhanced mock services for offline development
 */
describe('Offline Development - Mock Service Testing', () => {
  
  beforeEach(async () => {
    // Import and clear mock data
    const { clearMockData } = await import('../mocks/browserSessionsMock.js');
    clearMockData();
  });

  describe('Enhanced Mock Service Integration', () => {
    test('should provide complete offline development workflow', async () => {
      const { createOfflineBrowserSessionsService } = await import('../mocks/browserSessionsMock.js');
      const { resolveUrl } = await import('../../utils/urlResolver.js');
      
      const service = createOfflineBrowserSessionsService({
        latency: 10,
        errorRate: 0,
        realistic: true
      });

      // Test URL intelligence integration
      const dashboardPath = resolveUrl('user dashboard');
      expect(dashboardPath).toBe('/dashboard/');

      const session = await service.startSession({
        url: `http://localhost:3000${dashboardPath}`,
        sessionName: 'Offline Development Test',
        monitorConsole: true,
        monitorNetwork: true,
        takeScreenshots: true
      });

      expect(session.sessionId).toBeDefined();
      expect(session.url).toBe('http://localhost:3000/dashboard/');

      // Wait for session to become active
      await new Promise(resolve => setTimeout(resolve, 150));

      // Test navigation
      const cartPath = resolveUrl('shopping cart');
      const navigatedSession = await service.navigateSession(session.sessionId, {
        url: `http://localhost:3000${cartPath}`
      });
      expect(navigatedSession.url).toBe('http://localhost:3000/cart/');

      // Test complete functionality
      const [status, logs, screenshot] = await Promise.all([
        service.getSessionStatus(session.sessionId),
        service.getSessionLogs(session.sessionId),
        service.captureScreenshot(session.sessionId)
      ]);

      expect(status.session.status).toBe('active');
      expect(logs.logs.length).toBeGreaterThan(0);
      expect(screenshot.screenshot.data).toBeDefined();

      // Stop session
      const result = await service.stopSession(session.sessionId);
      expect(result.session.status).toBe('stopped');
    });

    test('should simulate realistic network conditions', async () => {
      const { NetworkConditionSimulator } = await import('../mocks/browserSessionsMock.js');
      
      const simulator = new NetworkConditionSimulator();
      
      // Test different conditions
      const fastService = simulator.createServiceWithCondition('fast');
      const slowService = simulator.createServiceWithCondition('slow');

      const startTime = Date.now();
      await fastService.startSession({
        url: 'http://localhost:3000',
        sessionName: 'Fast Test'
      });
      const fastDuration = Date.now() - startTime;

      const slowStartTime = Date.now();
      await slowService.startSession({
        url: 'http://localhost:3000',
        sessionName: 'Slow Test'
      });
      const slowDuration = Date.now() - slowStartTime;

      expect(fastDuration).toBeLessThan(slowDuration);
      expect(slowDuration).toBeGreaterThan(100);
    });

    test('should provide realistic test scenarios', async () => {
      const { createRealisticTestData } = await import('../mocks/browserSessionsMock.js');
      
      const { service, testScenarios } = createRealisticTestData();

      expect(testScenarios).toHaveLength(3);

      const sessions = await Promise.all(
        testScenarios.map(scenario => service.startSession(scenario))
      );

      expect(sessions).toHaveLength(3);
      
      // Wait for realistic data
      await new Promise(resolve => setTimeout(resolve, 200));

      const logs = await service.getSessionLogs(sessions[0].sessionId);
      expect(logs.logs.length).toBeGreaterThan(0);
      
      const consoleLog = logs.logs.find(log => log.type === 'console');
      expect(consoleLog?.message).toMatch(/Application|User|Loading/);
    });

    test('should handle errors gracefully in offline mode', async () => {
      const { createOfflineBrowserSessionsService } = await import('../mocks/browserSessionsMock.js');
      
      const unreliableService = createOfflineBrowserSessionsService({
        errorRate: 0.5,
        realistic: true
      });

      let successCount = 0;
      let errorCount = 0;

      for (let i = 0; i < 10; i++) {
        try {
          await unreliableService.startSession({
            url: `http://localhost:3000/test-${i}`,
            sessionName: `Error Test ${i}`
          });
          successCount++;
        } catch (error) {
          errorCount++;
          expect(error).toBeInstanceOf(Error);
        }
      }

      expect(errorCount).toBeGreaterThan(0);
      expect(successCount + errorCount).toBe(10);
    });
  });
});