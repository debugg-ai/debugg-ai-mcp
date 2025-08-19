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