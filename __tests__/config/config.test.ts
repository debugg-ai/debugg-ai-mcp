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

describe('config env var precedence', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'DEBUGGAI_API_TOKEN',
    'DEBUGGAI_JWT_TOKEN',
    'DEBUGGAI_API_KEY',
    'DEBUGGAI_TOKEN_TYPE',
    'DEBUGGAI_API_URL',
    'DEBUGGAI_LOCAL_PORT',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test('uses DEBUGGAI_API_TOKEN when set (first priority)', () => {
    process.env.DEBUGGAI_API_TOKEN = 'token-first';
    process.env.DEBUGGAI_JWT_TOKEN = 'token-second';
    process.env.DEBUGGAI_API_KEY = 'token-third';
    const cfg = loadConfig();
    expect(cfg.api.key).toBe('token-first');
  });

  test('uses DEBUGGAI_JWT_TOKEN when DEBUGGAI_API_TOKEN is not set (second priority)', () => {
    process.env.DEBUGGAI_JWT_TOKEN = 'token-second';
    process.env.DEBUGGAI_API_KEY = 'token-third';
    const cfg = loadConfig();
    expect(cfg.api.key).toBe('token-second');
  });

  test('uses DEBUGGAI_API_KEY when others are not set (third priority)', () => {
    process.env.DEBUGGAI_API_KEY = 'token-third';
    const cfg = loadConfig();
    expect(cfg.api.key).toBe('token-third');
  });

  test('throws when no API key env var is set', () => {
    expect(() => loadConfig()).toThrow('Configuration validation failed');
  });

  test('tokenType is bearer when DEBUGGAI_TOKEN_TYPE=bearer', () => {
    process.env.DEBUGGAI_API_KEY = 'some-key';
    process.env.DEBUGGAI_TOKEN_TYPE = 'bearer';
    const cfg = loadConfig();
    expect(cfg.api.tokenType).toBe('bearer');
  });

  test('tokenType defaults to token when DEBUGGAI_TOKEN_TYPE is not set', () => {
    process.env.DEBUGGAI_API_KEY = 'some-key';
    const cfg = loadConfig();
    expect(cfg.api.tokenType).toBe('token');
  });

  test('baseUrl uses DEBUGGAI_API_URL when set', () => {
    process.env.DEBUGGAI_API_KEY = 'some-key';
    process.env.DEBUGGAI_API_URL = 'https://custom.api.example.com';
    const cfg = loadConfig();
    expect(cfg.api.baseUrl).toBe('https://custom.api.example.com');
  });

  test('baseUrl defaults to production when DEBUGGAI_API_URL is not set', () => {
    process.env.DEBUGGAI_API_KEY = 'some-key';
    const cfg = loadConfig();
    expect(cfg.api.baseUrl).toBe('https://api.debugg.ai');
  });

  test('localPort is parsed as integer from DEBUGGAI_LOCAL_PORT', () => {
    process.env.DEBUGGAI_API_KEY = 'some-key';
    process.env.DEBUGGAI_LOCAL_PORT = '3000';
    const cfg = loadConfig();
    expect(cfg.defaults.localPort).toBe(3000);
  });

  test('localPort is undefined when DEBUGGAI_LOCAL_PORT is not set', () => {
    process.env.DEBUGGAI_API_KEY = 'some-key';
    const cfg = loadConfig();
    expect(cfg.defaults.localPort).toBeUndefined();
  });
});