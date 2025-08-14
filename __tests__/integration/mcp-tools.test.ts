/**
 * Integration tests for MCP tool handlers
 * These tests verify that the MCP tools work correctly end-to-end
 */

import { testPageChangesHandler } from '../../handlers/testPageChangesHandler.js';
import { config } from '../../config/index.js';
import { ToolContext } from '../../types/index.js';

describe('MCP Tool Handlers Integration Tests', () => {
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

  beforeAll(() => {
    // Skip tests if no API key is provided
    if (!config.api.key || config.api.key === 'test-key-placeholder' || config.api.key === 'test-api-key-for-testing') {
      console.log('Skipping MCP tool integration tests - no valid API key provided');
    }
  });

  describe('Test Page Changes Handler', () => {
    test('should create E2E test with minimal input', async () => {
      // Skip if no valid API key
      if (!config.api.key || config.api.key === 'test-key-placeholder' || config.api.key === 'test-api-key-for-testing') {
        return;
      }

      const input = {
        description: 'MCP Integration Test - minimal input'
      };

      const context: ToolContext = {
        requestId: 'test-123',
        timestamp: new Date(),
        progressToken: 'test-progress-token'
      };

      const result = await testPageChangesHandler(input, context, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);

      // Should have at least one text content with test results
      const textContent = result.content.find(c => c.type === 'text');
      expect(textContent).toBeDefined();
      expect(textContent!.text).toBeDefined();

      // Parse the JSON response
      const testResult = JSON.parse(textContent!.text);
      expect(testResult.testOutcome).toBeDefined();
      expect(testResult.executionTime).toBeDefined();
      expect(testResult.timestamp).toBeDefined();

      // Should have called progress callback
      expect(mockProgressCallback.calls.length).toBeGreaterThan(0);
    }, 60000);

    test('should create E2E test with full parameters', async () => {
      // Skip if no valid API key
      if (!config.api.key || config.api.key === 'test-key-placeholder' || config.api.key === 'test-api-key-for-testing') {
        return;
      }

      const input = {
        description: 'MCP Integration Test - full parameters',
        localPort: 3001,
        filePath: '/tmp/test/index.html',
        repoName: 'test-org/test-repo',
        branchName: 'feature-branch',
        repoPath: '/tmp/test'
      };

      const context: ToolContext = {
        requestId: 'test-456',
        timestamp: new Date(),
        progressToken: 'test-progress-token-2'
      };

      const result = await testPageChangesHandler(input, context, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);

      // Should have text content
      const textContent = result.content.find(c => c.type === 'text');
      expect(textContent).toBeDefined();

      const testResult = JSON.parse(textContent!.text);
      expect(testResult.testOutcome).toBeDefined();
      expect(['pass', 'fail', 'error']).toContain(testResult.testOutcome);

      // Should have called progress callback multiple times
      expect(mockProgressCallback.calls.length).toBeGreaterThan(0);

      // Verify progress callback was called with proper structure
      if (mockProgressCallback.calls.length > 0) {
        const firstCall = mockProgressCallback.calls[0][0];
        expect(firstCall.progress).toBeDefined();
        expect(typeof firstCall.progress).toBe('number');
        expect(firstCall.total).toBeDefined();
        expect(typeof firstCall.total).toBe('number');
      }
    }, 60000);

    test('should handle error cases gracefully', async () => {
      // Skip if no valid API key
      if (!config.api.key || config.api.key === 'test-key-placeholder' || config.api.key === 'test-api-key-for-testing') {
        return;
      }

      const input = {
        description: '' // Invalid: empty description
      };

      const context: ToolContext = {
        requestId: 'test-error',
        timestamp: new Date()
      };

      // Should throw validation error for empty description
      await expect(
        testPageChangesHandler(input, context, mockProgressCallback.mockImplementation.bind(mockProgressCallback))
      ).rejects.toThrow();
    }, 30000);

    test('should work without progress callback', async () => {
      // Skip if no valid API key
      if (!config.api.key || config.api.key === 'test-key-placeholder' || config.api.key === 'test-api-key-for-testing') {
        return;
      }

      const input = {
        description: 'MCP Integration Test - no progress callback'
      };

      const context: ToolContext = {
        requestId: 'test-no-progress',
        timestamp: new Date()
      };

      // Should work without progress callback
      const result = await testPageChangesHandler(input, context);

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
    }, 60000);

    test('should include screenshot when available', async () => {
      // Skip if no valid API key
      if (!config.api.key || config.api.key === 'test-key-placeholder' || config.api.key === 'test-api-key-for-testing') {
        return;
      }

      const input = {
        description: 'MCP Integration Test - screenshot test'
      };

      const context: ToolContext = {
        requestId: 'test-screenshot',
        timestamp: new Date(),
        progressToken: 'screenshot-test'
      };

      const result = await testPageChangesHandler(input, context, mockProgressCallback);

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();

      // May have image content if screenshot was generated
      const imageContent = result.content.find(c => c.type === 'image');
      if (imageContent) {
        expect(imageContent.data).toBeDefined();
        expect(imageContent.mimeType).toBe('image/png');
      }
    }, 60000);
  });

  describe('Configuration Integration', () => {
    test('should use environment-specific configuration', () => {
      expect(config.api.key).toBeDefined();
      expect(config.api.key.length).toBeGreaterThan(0);
      
      // Test logging configuration
      expect(config.logging.level).toBeDefined();
      expect(['error', 'warn', 'info', 'debug']).toContain(config.logging.level);
      expect(config.logging.format).toBeDefined();
      expect(['json', 'simple']).toContain(config.logging.format);
    });

    test('should have optional defaults when env vars not set', () => {
      // These should be undefined if not set via environment
      if (!process.env.DEBUGGAI_LOCAL_PORT) {
        expect(config.defaults.localPort).toBeUndefined();
      }
      
      if (!process.env.DEBUGGAI_LOCAL_REPO_NAME) {
        expect(config.defaults.repoName).toBeUndefined();
      }

      if (!process.env.DEBUGGAI_LOCAL_FILE_PATH) {
        expect(config.defaults.filePath).toBeUndefined();
      }
    });

    test('should use environment variables when provided', () => {
      // These should match what's in the test config
      if (process.env.DEBUGGAI_LOCAL_REPO_PATH) {
        expect(config.defaults.repoPath).toBe(process.env.DEBUGGAI_LOCAL_REPO_PATH);
      }

      if (process.env.DEBUGGAI_LOCAL_REPO_NAME) {
        expect(config.defaults.repoName).toBe(process.env.DEBUGGAI_LOCAL_REPO_NAME);
      }

      if (process.env.ENVIRONMENT && process.env.ENVIRONMENT !== 'test') {
        expect(process.env.ENVIRONMENT).toBe('local');
      }
    });
  });
});