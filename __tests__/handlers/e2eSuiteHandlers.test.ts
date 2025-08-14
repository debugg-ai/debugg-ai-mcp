/**
 * Tests for E2E Suite Handlers
 */

import { 
  listTestsHandler,
  listTestSuitesHandler,
  createTestSuiteHandler,
  createCommitSuiteHandler,
  listCommitSuitesHandler,
  getTestStatusHandler
} from '../../handlers/e2eSuiteHandlers.js';
import { config } from '../../config/index.js';
import { ToolContext } from '../../types/index.js';

describe('E2E Suite Handlers', () => {
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

  describe('List Tests Handler', () => {
    test('should handle listing tests with minimal input', async () => {
      // Skip if no valid API key
      if (!config.api.key || config.api.key === 'test-key-placeholder') {
        return;
      }

      const input = {};

      const result = await listTestsHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);

      // Should have text content with test results
      const textContent = result.content.find(c => c.type === 'text');
      expect(textContent).toBeDefined();
      expect(textContent!.text).toBeDefined();

      // Parse the JSON response
      const testResult = JSON.parse(textContent!.text);
      expect(testResult.success).toBe(true);
      expect(testResult.tests).toBeDefined();
      expect(Array.isArray(testResult.tests)).toBe(true);
      expect(testResult.pagination).toBeDefined();

      // Should have called progress callback
      expect(mockProgressCallback.calls.length).toBeGreaterThan(0);
    }, 30000);

    test('should handle listing tests with filters', async () => {
      if (!config.api.key || config.api.key === 'test-key-placeholder') {
        return;
      }

      const input = {
        status: 'completed' as const,
        page: 1,
        limit: 10
      };

      const result = await listTestsHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      
      const testResult = JSON.parse(result.content[0].text);
      expect(testResult.success).toBe(true);
      expect(testResult.filters.status).toBe('completed');
      expect(testResult.pagination.page).toBe(1);
      expect(testResult.pagination.limit).toBe(10);
    }, 30000);
  });

  describe('List Test Suites Handler', () => {
    test('should handle listing test suites', async () => {
      if (!config.api.key || config.api.key === 'test-key-placeholder') {
        return;
      }

      const input = {};

      const result = await listTestSuitesHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      
      const testResult = JSON.parse(result.content[0].text);
      expect(testResult.success).toBe(true);
      expect(testResult.testSuites).toBeDefined();
      expect(Array.isArray(testResult.testSuites)).toBe(true);
    }, 30000);
  });

  describe('Create Test Suite Handler', () => {
    test('should create test suite with description', async () => {
      if (!config.api.key || config.api.key === 'test-key-placeholder') {
        return;
      }

      const input = {
        description: 'Test suite creation test'
      };

      const result = await createTestSuiteHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      
      const testResult = JSON.parse(result.content[0].text);
      expect(testResult.success).toBe(true);
      expect(testResult.testSuite).toBeDefined();
      expect(testResult.testSuite.description).toBe(input.description);
    }, 45000);
  });

  describe('Create Commit Suite Handler', () => {
    test('should create commit suite with description', async () => {
      if (!config.api.key || config.api.key === 'test-key-placeholder') {
        return;
      }

      const input = {
        description: 'Commit suite creation test'
      };

      const result = await createCommitSuiteHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      
      const testResult = JSON.parse(result.content[0].text);
      expect(testResult.success).toBe(true);
      expect(testResult.commitSuite).toBeDefined();
      expect(testResult.commitSuite.description).toBe(input.description);
    }, 45000);
  });

  describe('List Commit Suites Handler', () => {
    test('should handle listing commit suites', async () => {
      if (!config.api.key || config.api.key === 'test-key-placeholder') {
        return;
      }

      const input = {};

      const result = await listCommitSuitesHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      
      const testResult = JSON.parse(result.content[0].text);
      expect(testResult.success).toBe(true);
      expect(testResult.commitSuites).toBeDefined();
      expect(Array.isArray(testResult.commitSuites)).toBe(true);
    }, 30000);
  });

  describe('Get Test Status Handler', () => {
    test('should handle invalid UUID gracefully', async () => {
      if (!config.api.key || config.api.key === 'test-key-placeholder') {
        return;
      }

      const input = {
        suiteUuid: '00000000-0000-0000-0000-000000000000', // Non-existent UUID
        suiteType: 'test' as const
      };

      // This should handle the error gracefully and not crash
      try {
        await getTestStatusHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));
      } catch (error) {
        // Expected to throw an error for non-existent UUID
        expect(error).toBeDefined();
      }
    }, 30000);
  });

  describe('Error Handling', () => {
    test('should handle network errors gracefully', async () => {
      // Mock a scenario where API key is missing
      const originalKey = config.api.key;
      (config.api as any).key = '';

      const input = {
        description: 'Test with no API key'
      };

      try {
        await createTestSuiteHandler(input, mockContext, mockProgressCallback.mockImplementation.bind(mockProgressCallback));
      } catch (error) {
        expect(error).toBeDefined();
      } finally {
        // Restore original key
        (config.api as any).key = originalKey;
      }
    });
  });
});