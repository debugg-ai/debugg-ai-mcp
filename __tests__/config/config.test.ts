import { z } from 'zod';
import { loadConfig, config } from '../../config/index.js';

describe('Configuration Management', () => {
  beforeAll(() => {
    // Set required environment variable for testing
    if (!process.env.DEBUGGAI_API_KEY) {
      process.env.DEBUGGAI_API_KEY = 'test-api-key-for-jest';
    }
  });

  test('loadConfig should successfully load configuration', () => {
    const result = loadConfig();
    
    expect(result).toBeDefined();
    expect(result.server).toBeDefined();
    expect(result.api).toBeDefined();
    expect(result.defaults).toBeDefined();
    expect(result.logging).toBeDefined();
  });

  test('config should have proper structure', () => {
    expect(config.server.name).toBe('DebuggAI MCP Server');
    expect(config.server.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(config.api.key).toBeDefined();
    expect(config.logging.level).toMatch(/^(error|warn|info|debug)$/);
    expect(config.logging.format).toMatch(/^(json|simple)$/);
  });

  test('config should handle optional defaults correctly', () => {
    // These should be undefined if environment variables are not set
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

  test('config should throw error for missing API key', () => {
    const originalApiKey = process.env.DEBUGGAI_API_KEY;
    delete process.env.DEBUGGAI_API_KEY;
    
    expect(() => {
      loadConfig();
    }).toThrow('Configuration validation failed');
    
    // Restore the API key
    if (originalApiKey) {
      process.env.DEBUGGAI_API_KEY = originalApiKey;
    }
  });
});