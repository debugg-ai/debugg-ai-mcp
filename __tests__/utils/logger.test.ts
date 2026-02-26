import { jest } from '@jest/globals';
import { Logger, defaultLogger } from '../../utils/logger.js';

describe('Logger Utility', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger({ component: 'test' });
  });

  test('should create a logger instance', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  test('should create child logger with additional context', () => {
    const childLogger = logger.child({ operation: 'child-test' });
    expect(childLogger).toBeDefined();
    expect(childLogger).toBeInstanceOf(Logger);
  });

  test('should sanitize sensitive input data', () => {
    const sensitiveInput = {
      username: 'testuser',
      password: 'secret123',
      apiKey: 'key123',
      token: 'token123'
    };

    // Test that sanitization works by calling toolStart which uses sanitizeInput
    expect(() => {
      logger.toolStart('test-tool', sensitiveInput);
    }).not.toThrow();
  });

  test('should track tool execution timing', () => {
    const toolName = 'test-tool';
    const startTime = Date.now();
    
    expect(() => {
      logger.toolStart(toolName, { input: 'test' });
      logger.toolComplete(toolName, Date.now() - startTime);
    }).not.toThrow();
  });

  test('should log tool errors with context', () => {
    const toolName = 'failing-tool';
    const error = new Error('Test error');
    const duration = 100;
    
    expect(() => {
      logger.toolError(toolName, error, duration);
    }).not.toThrow();
  });

  test('should log progress updates', () => {
    expect(() => {
      logger.progress('Testing progress', 50, 100);
    }).not.toThrow();
  });

  test('defaultLogger should be available', () => {
    expect(defaultLogger).toBeDefined();
    expect(defaultLogger).toBeInstanceOf(Logger);
  });
});

describe('sensitive field redaction', () => {
  let loggerInstance: Logger;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    loggerInstance = new Logger({ component: 'redaction-test' });
    // Spy on the logger's info method to capture what gets passed
    infoSpy = jest.spyOn(loggerInstance, 'info');
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  test('redacts password field', () => {
    loggerInstance.toolStart('test-tool', { password: 'super-secret' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ input: expect.objectContaining({ password: '[REDACTED]' }) })
    );
  });

  test('redacts apiKey field', () => {
    loggerInstance.toolStart('test-tool', { apiKey: 'my-api-key' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ input: expect.objectContaining({ apiKey: '[REDACTED]' }) })
    );
  });

  test('redacts token field', () => {
    loggerInstance.toolStart('test-tool', { token: 'jwt-token-value' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ input: expect.objectContaining({ token: '[REDACTED]' }) })
    );
  });

  test('redacts secret field', () => {
    loggerInstance.toolStart('test-tool', { secret: 'shhh' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ input: expect.objectContaining({ secret: '[REDACTED]' }) })
    );
  });

  test('redacts key field', () => {
    loggerInstance.toolStart('test-tool', { key: 'some-key-value' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ input: expect.objectContaining({ key: '[REDACTED]' }) })
    );
  });

  test('does not redact non-sensitive fields', () => {
    loggerInstance.toolStart('test-tool', { username: 'testuser', action: 'login' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({ username: 'testuser', action: 'login' })
      })
    );
  });

  test('returns non-object input as-is', () => {
    loggerInstance.toolStart('test-tool', 'plain-string');
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ input: 'plain-string' })
    );
  });

  test('returns null input as-is', () => {
    loggerInstance.toolStart('test-tool', null);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ input: null })
    );
  });

  test('redacts fields with sensitive substring (e.g. authtoken contains token)', () => {
    loggerInstance.toolStart('test-tool', { authtoken: 'my-auth-token' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ input: expect.objectContaining({ authtoken: '[REDACTED]' }) })
    );
  });
});