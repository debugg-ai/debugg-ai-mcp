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

  test('config should have defaults object', () => {
    expect(config.defaults).toBeDefined();
  });

  test('config loads with empty key when DEBUGGAI_API_KEY is missing (bead cma: deferred validation)', () => {
    const saved = {
      DEBUGGAI_API_KEY: process.env.DEBUGGAI_API_KEY,
      DEBUGGAI_API_TOKEN: process.env.DEBUGGAI_API_TOKEN,
      DEBUGGAI_JWT_TOKEN: process.env.DEBUGGAI_JWT_TOKEN,
    };
    delete process.env.DEBUGGAI_API_KEY;
    delete process.env.DEBUGGAI_API_TOKEN;
    delete process.env.DEBUGGAI_JWT_TOKEN;

    // Must NOT throw — validation is deferred to first tool call so MCP
    // clients get a proper initialize + structured tool error instead of
    // "Failed to reconnect".
    const cfg = loadConfig();
    expect(cfg.api.key).toBe('');

    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
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

  test('loads with empty key when no API key env var is set (bead cma: deferred validation)', () => {
    const cfg = loadConfig();
    expect(cfg.api.key).toBe('');
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

  describe('telemetry posthogApiKey resolution', () => {
    let saved: Record<string, string | undefined>;
    beforeEach(() => {
      saved = {
        POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
        DEBUGGAI_TELEMETRY_DISABLED: process.env.DEBUGGAI_TELEMETRY_DISABLED,
      };
      delete process.env.POSTHOG_API_KEY;
      delete process.env.DEBUGGAI_TELEMETRY_DISABLED;
    });
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    test('defaults to embedded public phc_* key when no env vars set', () => {
      const cfg = loadConfig();
      expect(cfg.telemetry.posthogApiKey).toMatch(/^phc_/);
    });

    test('POSTHOG_API_KEY env override takes precedence over default', () => {
      process.env.POSTHOG_API_KEY = 'phc_custom_test_key';
      const cfg = loadConfig();
      expect(cfg.telemetry.posthogApiKey).toBe('phc_custom_test_key');
    });

    test('DEBUGGAI_TELEMETRY_DISABLED=1 disables telemetry (returns undefined)', () => {
      process.env.DEBUGGAI_TELEMETRY_DISABLED = '1';
      const cfg = loadConfig();
      expect(cfg.telemetry.posthogApiKey).toBeUndefined();
    });

    test('DEBUGGAI_TELEMETRY_DISABLED accepts true / yes / on (case-insensitive)', () => {
      for (const v of ['true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
        process.env.DEBUGGAI_TELEMETRY_DISABLED = v;
        const cfg = loadConfig();
        expect(cfg.telemetry.posthogApiKey).toBeUndefined();
      }
    });

    test('DEBUGGAI_TELEMETRY_DISABLED=0 / empty does NOT disable (defaults still apply)', () => {
      process.env.DEBUGGAI_TELEMETRY_DISABLED = '0';
      let cfg = loadConfig();
      expect(cfg.telemetry.posthogApiKey).toMatch(/^phc_/);
      process.env.DEBUGGAI_TELEMETRY_DISABLED = '';
      cfg = loadConfig();
      expect(cfg.telemetry.posthogApiKey).toMatch(/^phc_/);
    });

    test('DEBUGGAI_TELEMETRY_DISABLED overrides POSTHOG_API_KEY', () => {
      process.env.POSTHOG_API_KEY = 'phc_user_custom';
      process.env.DEBUGGAI_TELEMETRY_DISABLED = '1';
      const cfg = loadConfig();
      expect(cfg.telemetry.posthogApiKey).toBeUndefined();
    });
  });

});