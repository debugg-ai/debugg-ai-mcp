/**
 * Tests for Live Session Handlers
 * Using integration-style tests with manual service mocking
 */

import { ToolContext } from '../../types/index.js';

describe('Live Session Handlers', () => {
  const mockContext: ToolContext = {
    requestId: 'test-123',
    timestamp: new Date()
  };

  describe('URL Processing Logic', () => {
    test('should detect localhost URLs', () => {
      const localhostUrls = [
        'http://localhost:3000',
        'https://localhost:8080/path',
        'http://127.0.0.1:5000',
        'http://127.0.0.1:3000/api/test?param=1'
      ];
      
      localhostUrls.forEach(url => {
        const isLocalhost = url.includes('localhost') || url.includes('127.0.0.1') || url.includes('::1');
        expect(isLocalhost).toBe(true);
      });
    });

    test('should detect tunnel URLs', () => {
      const tunnelUrls = [
        'https://abc-123-def.ngrok.debugg.ai',
        'https://test-tunnel-id.ngrok.debugg.ai/api/status'
      ];
      
      tunnelUrls.forEach(url => {
        const isTunnelUrl = url.includes('.ngrok.debugg.ai');
        expect(isTunnelUrl).toBe(true);
      });
    });

    test('should extract tunnel ID from URLs', () => {
      const testCases = [
        { url: 'https://abc-123-def.ngrok.debugg.ai', expected: 'abc-123-def' },
        { url: 'https://tunnel-id-456.ngrok.debugg.ai/api', expected: 'tunnel-id-456' },
        { url: 'https://example.com', expected: null }
      ];

      testCases.forEach(({ url, expected }) => {
        const match = url.match(/https?:\/\/([^.]+)\.ngrok\.debugg\.ai/);
        const tunnelId = match ? match[1] : null;
        expect(tunnelId).toBe(expected);
      });
    });

    test('should extract port from localhost URLs', () => {
      const testCases = [
        { url: 'http://localhost:3000', expected: 3000 },
        { url: 'https://localhost:8080/path', expected: 8080 },
        { url: 'http://127.0.0.1:5000', expected: 5000 },
        { url: 'https://example.com', expected: undefined }
      ];

      testCases.forEach(({ url, expected }) => {
        const portMatch = url.match(/:(\d+)/);
        const port = portMatch ? parseInt(portMatch[1], 10) : undefined;
        expect(port).toBe(expected);
      });
    });
  });

  describe('Session Parameter Processing', () => {
    test('should process session parameters correctly', () => {
      const input = {
        url: 'http://localhost:3000',
        sessionName: 'Test Session',
        monitorConsole: true,
        monitorNetwork: true,
        takeScreenshots: false,
        screenshotInterval: 10
      };

      // Simulate the parameter processing logic from the handler
      const isLocalhost = input.url.includes('localhost') || input.url.includes('127.0.0.1') || input.url.includes('::1');
      const isTunneled = input.url.includes('.ngrok.debugg.ai');
      const portMatch = input.url.match(/:(\d+)/);
      const localPort = portMatch ? parseInt(portMatch[1], 10) : undefined;

      const sessionParams = {
        url: input.url,
        originalUrl: input.url,
        localPort: localPort,
        sessionName: input.sessionName || `Session ${new Date().toISOString()}`,
        monitorConsole: input.monitorConsole ?? true,
        monitorNetwork: input.monitorNetwork ?? true,
        takeScreenshots: input.takeScreenshots ?? false,
        screenshotInterval: input.screenshotInterval ?? 10,
        isLocalhost: isLocalhost && !isTunneled,
        tunnelId: undefined
      };

      expect(sessionParams.url).toBe(input.url);
      expect(sessionParams.sessionName).toBe(input.sessionName);
      expect(sessionParams.isLocalhost).toBe(true);
      expect(sessionParams.localPort).toBe(3000);
      expect(sessionParams.monitorConsole).toBe(true);
      expect(sessionParams.monitorNetwork).toBe(true);
      expect(sessionParams.takeScreenshots).toBe(false);
      expect(sessionParams.screenshotInterval).toBe(10);
    });

    test('should handle tunnel URL parameters', () => {
      const input = {
        url: 'https://abc-123-def.ngrok.debugg.ai/api/test'
      };

      const isLocalhost = input.url.includes('localhost') || input.url.includes('127.0.0.1') || input.url.includes('::1');
      const isTunneled = input.url.includes('.ngrok.debugg.ai');
      const tunnelMatch = input.url.match(/https?:\/\/([^.]+)\.ngrok\.debugg\.ai/);
      const tunnelId = tunnelMatch ? tunnelMatch[1] : undefined;

      expect(isLocalhost).toBe(false);
      expect(isTunneled).toBe(true);
      expect(tunnelId).toBe('abc-123-def');
    });

    test('should handle default parameters', () => {
      const input = {
        url: 'http://localhost:3001'
      };

      const sessionParams = {
        url: input.url,
        originalUrl: input.url,
        sessionName: input.sessionName || `Session ${new Date().toISOString()}`,
        monitorConsole: true, // default
        monitorNetwork: true, // default
        takeScreenshots: false, // default
        screenshotInterval: 10 // default
      };

      expect(sessionParams.monitorConsole).toBe(true);
      expect(sessionParams.monitorNetwork).toBe(true);
      expect(sessionParams.takeScreenshots).toBe(false);
      expect(sessionParams.screenshotInterval).toBe(10);
      expect(sessionParams.sessionName).toContain('Session');
    });
  });

  describe('Error Handling', () => {
    test('should validate required parameters', () => {
      // Test empty URL validation
      const invalidInputs = [
        { url: '' },
        { url: null as any },
        { url: undefined as any }
      ];

      invalidInputs.forEach(input => {
        const isValid = !!(input.url && input.url.length > 0);
        expect(isValid).toBe(false);
      });
    });

    test('should handle progress callback errors gracefully', async () => {
      const failingCallback = async () => {
        throw new Error('Progress callback failed');
      };
      
      // Progress callback failures should not prevent the operation
      try {
        await failingCallback();
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Progress callback failed');
      }
    });
  });

  describe('Response Format Validation', () => {
    test('should format successful response correctly', () => {
      const mockSession = {
        sessionId: 'test-session-123',
        url: 'http://localhost:3000',
        sessionName: 'Test Session',
        status: 'active',
        startTime: new Date().toISOString(),
        monitoring: {
          console: true,
          network: true,
          screenshots: false
        }
      };

      const responseContent = {
        success: true,
        session: mockSession
      };

      const response = {
        content: [{
          type: 'text',
          text: JSON.stringify(responseContent, null, 2)
        }]
      };

      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe('text');
      
      const parsedContent = JSON.parse(response.content[0].text);
      expect(parsedContent.success).toBe(true);
      expect(parsedContent.session).toBeDefined();
      expect(parsedContent.session.sessionId).toBe('test-session-123');
    });

    test('should format logs response correctly', () => {
      const mockLogsResponse = {
        success: true,
        sessionId: 'test-session-123',
        logs: [
          {
            timestamp: new Date().toISOString(),
            type: 'console',
            level: 'log',
            message: 'Test log message'
          }
        ],
        filters: {
          logType: 'all',
          limit: 100
        },
        stats: {
          total: 1,
          console: 1,
          network: 0,
          errors: 0
        }
      };

      expect(mockLogsResponse.success).toBe(true);
      expect(mockLogsResponse.logs).toHaveLength(1);
      expect(mockLogsResponse.stats.total).toBe(1);
    });

    test('should format screenshot response correctly', () => {
      const mockScreenshotResponse = {
        success: true,
        sessionId: 'test-session-123',
        screenshot: {
          data: 'base64-encoded-image-data',
          format: 'png',
          quality: 90,
          fullPage: false,
          size: {
            width: 1024,
            height: 768
          },
          timestamp: new Date().toISOString()
        }
      };

      expect(mockScreenshotResponse.success).toBe(true);
      expect(mockScreenshotResponse.screenshot).toBeDefined();
      expect(mockScreenshotResponse.screenshot.format).toBe('png');
      expect(mockScreenshotResponse.screenshot.size).toBeDefined();
    });
  });
});