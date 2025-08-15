/**
 * Unit tests for Live Session Handler input validation and response formatting
 */

import { 
  StartLiveSessionInputSchema,
  StopLiveSessionInputSchema,
  GetLiveSessionStatusInputSchema,
  GetLiveSessionLogsInputSchema,
  GetLiveSessionScreenshotInputSchema,
  StartLiveSessionInput,
  StopLiveSessionInput,
  GetLiveSessionStatusInput,
  GetLiveSessionLogsInput,
  GetLiveSessionScreenshotInput
} from '../../types/index.js';

describe('Live Session Handlers - Input Validation', () => {
  
  describe('StartLiveSession Input Validation', () => {
    test('should validate correct StartLiveSession input', () => {
      const validInput = {
        url: 'https://example.com',
        sessionName: 'Test Session',
        monitorConsole: true,
        monitorNetwork: true,
        takeScreenshots: false,
        screenshotInterval: 30
      };

      const result = StartLiveSessionInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.url).toBe('https://example.com');
        expect(result.data.sessionName).toBe('Test Session');
        expect(result.data.monitorConsole).toBe(true);
        expect(result.data.monitorNetwork).toBe(true);
        expect(result.data.takeScreenshots).toBe(false);
        expect(result.data.screenshotInterval).toBe(30);
      }
    });

    test('should validate minimal StartLiveSession input', () => {
      const minimalInput = {
        url: 'http://localhost:3000'
      };

      const result = StartLiveSessionInputSchema.safeParse(minimalInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.url).toBe('http://localhost:3000');
        expect(result.data.monitorConsole).toBe(true); // default
        expect(result.data.monitorNetwork).toBe(true); // default
        expect(result.data.takeScreenshots).toBe(false); // default
        expect(result.data.screenshotInterval).toBe(10); // default
      }
    });

    test('should reject StartLiveSession with invalid URL', () => {
      const invalidInput = {
        url: '' // Empty URL
      };

      const result = StartLiveSessionInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    test('should reject StartLiveSession with invalid port', () => {
      const invalidInput = {
        url: 'http://localhost:3000',
        localPort: 70000 // Too high
      };

      const result = StartLiveSessionInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    test('should reject StartLiveSession with invalid screenshot interval', () => {
      const invalidInput = {
        url: 'http://localhost:3000',
        screenshotInterval: 500 // Too high (max is 300)
      };

      const result = StartLiveSessionInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    test('should reject StartLiveSession with too long session name', () => {
      const invalidInput = {
        url: 'http://localhost:3000',
        sessionName: 'A'.repeat(150) // Too long (max is 100)
      };

      const result = StartLiveSessionInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('StopLiveSession Input Validation', () => {
    test('should validate StopLiveSession with sessionId', () => {
      const validInput = {
        sessionId: 'session-123'
      };

      const result = StopLiveSessionInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.sessionId).toBe('session-123');
      }
    });

    test('should validate empty StopLiveSession input', () => {
      const emptyInput = {};

      const result = StopLiveSessionInputSchema.safeParse(emptyInput);
      expect(result.success).toBe(true);
    });
  });

  describe('GetLiveSessionStatus Input Validation', () => {
    test('should validate GetLiveSessionStatus with sessionId', () => {
      const validInput = {
        sessionId: 'session-456'
      };

      const result = GetLiveSessionStatusInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.sessionId).toBe('session-456');
      }
    });

    test('should validate empty GetLiveSessionStatus input', () => {
      const emptyInput = {};

      const result = GetLiveSessionStatusInputSchema.safeParse(emptyInput);
      expect(result.success).toBe(true);
    });
  });

  describe('GetLiveSessionLogs Input Validation', () => {
    test('should validate complete GetLiveSessionLogs input', () => {
      const validInput = {
        sessionId: 'session-789',
        logType: 'console' as const,
        since: '2024-01-01T12:00:00Z',
        limit: 50
      };

      const result = GetLiveSessionLogsInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.sessionId).toBe('session-789');
        expect(result.data.logType).toBe('console');
        expect(result.data.since).toBe('2024-01-01T12:00:00Z');
        expect(result.data.limit).toBe(50);
      }
    });

    test('should validate minimal GetLiveSessionLogs input', () => {
      const minimalInput = {};

      const result = GetLiveSessionLogsInputSchema.safeParse(minimalInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.logType).toBe('all'); // default
        expect(result.data.limit).toBe(100); // default
      }
    });

    test('should validate all log types', () => {
      const logTypes = ['console', 'network', 'errors', 'all'] as const;
      
      for (const logType of logTypes) {
        const input = { logType };
        const result = GetLiveSessionLogsInputSchema.safeParse(input);
        expect(result.success).toBe(true);
        
        if (result.success) {
          expect(result.data.logType).toBe(logType);
        }
      }
    });

    test('should reject invalid log type', () => {
      const invalidInput = {
        logType: 'invalid-type'
      };

      const result = GetLiveSessionLogsInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    test('should reject invalid limit', () => {
      const invalidInputs = [
        { limit: 0 }, // Too low
        { limit: 2000 }, // Too high
      ];

      for (const invalidInput of invalidInputs) {
        const result = GetLiveSessionLogsInputSchema.safeParse(invalidInput);
        expect(result.success).toBe(false);
      }
    });

    test('should reject invalid timestamp format', () => {
      const invalidInput = {
        since: '2024-01-01 12:00:00' // Missing T and Z
      };

      const result = GetLiveSessionLogsInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('GetLiveSessionScreenshot Input Validation', () => {
    test('should validate complete GetLiveSessionScreenshot input', () => {
      const validInput = {
        sessionId: 'session-screenshot',
        fullPage: true,
        quality: 85,
        format: 'jpeg' as const
      };

      const result = GetLiveSessionScreenshotInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.sessionId).toBe('session-screenshot');
        expect(result.data.fullPage).toBe(true);
        expect(result.data.quality).toBe(85);
        expect(result.data.format).toBe('jpeg');
      }
    });

    test('should validate minimal GetLiveSessionScreenshot input', () => {
      const minimalInput = {};

      const result = GetLiveSessionScreenshotInputSchema.safeParse(minimalInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.fullPage).toBe(false); // default
        expect(result.data.quality).toBe(90); // default
        expect(result.data.format).toBe('png'); // default
      }
    });

    test('should validate both image formats', () => {
      const formats = ['png', 'jpeg'] as const;
      
      for (const format of formats) {
        const input = { format };
        const result = GetLiveSessionScreenshotInputSchema.safeParse(input);
        expect(result.success).toBe(true);
        
        if (result.success) {
          expect(result.data.format).toBe(format);
        }
      }
    });

    test('should reject invalid format', () => {
      const invalidInput = {
        format: 'gif'
      };

      const result = GetLiveSessionScreenshotInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    test('should reject invalid quality values', () => {
      const invalidInputs = [
        { quality: 0 }, // Too low
        { quality: 150 }, // Too high
        { quality: -1 }, // Negative
      ];

      for (const invalidInput of invalidInputs) {
        const result = GetLiveSessionScreenshotInputSchema.safeParse(invalidInput);
        expect(result.success).toBe(false);
      }
    });
  });

  describe('Response Format Tests', () => {
    test('should validate expected ToolResponse structure', () => {
      const mockResponse = {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            session: {
              sessionId: 'test-session-123',
              sessionName: 'Test Session',
              url: 'https://example.com',
              status: 'active',
              startTime: '2024-01-01T12:00:00Z',
              monitoring: {
                console: true,
                network: true,
                screenshots: false
              }
            }
          }, null, 2)
        }]
      };

      expect(mockResponse.content).toBeDefined();
      expect(Array.isArray(mockResponse.content)).toBe(true);
      expect(mockResponse.content.length).toBe(1);
      expect(mockResponse.content[0].type).toBe('text');
      expect(mockResponse.content[0].text).toBeDefined();

      // Validate JSON structure
      const parsedContent = JSON.parse(mockResponse.content[0].text!);
      expect(parsedContent.success).toBe(true);
      expect(parsedContent.session).toBeDefined();
      expect(parsedContent.session.sessionId).toBeDefined();
      expect(parsedContent.session.status).toBeDefined();
    });

    test('should validate progress update structure', () => {
      const progressUpdate = {
        progress: 2,
        total: 4,
        message: 'Processing request...'
      };

      expect(progressUpdate.progress).toBeGreaterThan(0);
      expect(progressUpdate.total).toBeGreaterThanOrEqual(progressUpdate.progress);
      expect(progressUpdate.message).toBeDefined();
      expect(typeof progressUpdate.message).toBe('string');
      expect(progressUpdate.message.length).toBeGreaterThan(0);
    });
  });

  describe('Error Scenarios', () => {
    test('should handle missing required fields', () => {
      // Test with completely empty object for required URL
      const result = StartLiveSessionInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    test('should handle type mismatches', () => {
      const invalidInputs = [
        { url: 123 }, // URL should be string
        { monitorConsole: 'yes' }, // Should be boolean
        { localPort: '3000' }, // Should be number
        { screenshotInterval: 'fast' }, // Should be number
      ];

      for (const invalidInput of invalidInputs) {
        const result = StartLiveSessionInputSchema.safeParse(invalidInput);
        expect(result.success).toBe(false);
      }
    });
  });

  describe('URL Validation Edge Cases', () => {
    test('should accept valid localhost URLs', () => {
      const validUrls = [
        'http://localhost:3000',
        'http://localhost:8080',
        'https://localhost:5000'
      ];

      for (const url of validUrls) {
        const input = { url };
        const result = StartLiveSessionInputSchema.safeParse(input);
        expect(result.success).toBe(true);
      }
    });

    test('should accept valid external URLs', () => {
      const validUrls = [
        'https://example.com',
        'https://api.example.com/v1',
        'http://staging.example.com:8080'
      ];

      for (const url of validUrls) {
        const input = { url };
        const result = StartLiveSessionInputSchema.safeParse(input);
        expect(result.success).toBe(true);
      }
    });

    test('should reject completely invalid URLs', () => {
      const invalidUrls = [
        '',
        ' ',
        'not-a-url',
        'ftp://unsupported-protocol.com'
      ];

      for (const url of invalidUrls) {
        const input = { url };
        const result = StartLiveSessionInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      }
    });
  });
});