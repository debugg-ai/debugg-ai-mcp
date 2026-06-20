/**
 * Request-scoped API key (epic lybfq): AsyncLocalStorage + config.api.key
 * resolution. Proves the HTTP transport can override the env key per request
 * while stdio (no request scope) keeps using the env key.
 */

import { runWithApiKey, currentApiKey } from '../../utils/requestContext.js';
import { config, _resetConfigForTest } from '../../config/index.js';

describe('requestContext', () => {
  test('currentApiKey is undefined outside a request scope', () => {
    expect(currentApiKey()).toBeUndefined();
  });

  test('runWithApiKey exposes the key only for the duration', () => {
    runWithApiKey('req-token', () => {
      expect(currentApiKey()).toBe('req-token');
    });
    expect(currentApiKey()).toBeUndefined();
  });
});

describe('config.api.key request scoping', () => {
  const prev = process.env.DEBUGGAI_API_KEY;
  beforeAll(() => {
    process.env.DEBUGGAI_API_KEY = 'env-key';
    _resetConfigForTest();
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.DEBUGGAI_API_KEY;
    else process.env.DEBUGGAI_API_KEY = prev;
    _resetConfigForTest();
  });

  test('returns the env key outside a request', () => {
    expect(config.api.key).toBe('env-key');
  });

  test('returns the request key inside runWithApiKey, then reverts', () => {
    runWithApiKey('req-token', () => {
      expect(config.api.key).toBe('req-token');
    });
    expect(config.api.key).toBe('env-key');
  });

  test('the request key survives awaits inside the scope', async () => {
    await runWithApiKey('async-token', async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      expect(config.api.key).toBe('async-token');
    });
    expect(config.api.key).toBe('env-key');
  });

  test('other config fields are unaffected by the override', () => {
    runWithApiKey('req-token', () => {
      expect(config.api.baseUrl).toContain('debugg.ai');
      expect(config.api.tokenType).toBeDefined();
    });
  });
});
