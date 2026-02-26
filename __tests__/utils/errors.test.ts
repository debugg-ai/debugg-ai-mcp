/**
 * Tests for utils/errors.ts
 *
 * Covers all exported functions:
 *  - toMCPError
 *  - createErrorResponse
 *  - withErrorHandling
 *  - handleConfigurationError
 *  - handleExternalServiceError
 *  - isRetryableError
 *  - createAuthenticationError
 */

import {
  toMCPError,
  createErrorResponse,
  withErrorHandling,
  handleConfigurationError,
  handleExternalServiceError,
  isRetryableError,
  createAuthenticationError,
} from '../../utils/errors.js';
import { MCPError, MCPErrorCode } from '../../types/index.js';

// ── toMCPError ───────────────────────────────────────────────────────────────

describe('toMCPError', () => {
  test('returns same instance when given an MCPError', () => {
    const original = new MCPError(MCPErrorCode.VALIDATION_ERROR, 'bad input');
    const result = toMCPError(original);
    expect(result).toBe(original);
  });

  test('wraps a standard Error into MCPError with INTERNAL_ERROR code', () => {
    const err = new TypeError('boom');
    const result = toMCPError(err, 'some-context');
    expect(result).toBeInstanceOf(MCPError);
    expect(result.code).toBe(MCPErrorCode.INTERNAL_ERROR);
    expect(result.message).toBe('boom');
    expect(result.data).toMatchObject({
      originalError: 'TypeError',
      context: 'some-context',
    });
  });

  test('wraps a non-Error value (string)', () => {
    const result = toMCPError('string-error');
    expect(result).toBeInstanceOf(MCPError);
    expect(result.code).toBe(MCPErrorCode.INTERNAL_ERROR);
    expect(result.message).toContain('string-error');
  });

  test('wraps a non-Error value (number)', () => {
    const result = toMCPError(42);
    expect(result).toBeInstanceOf(MCPError);
    expect(result.message).toContain('42');
  });
});

// ── createErrorResponse ──────────────────────────────────────────────────────

describe('createErrorResponse', () => {
  test('returns ToolResponse shape with isError: true', () => {
    const resp = createErrorResponse(new Error('fail'), 'myTool');
    expect(resp.isError).toBe(true);
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0].type).toBe('text');
  });

  test('content text is valid JSON containing error details', () => {
    const resp = createErrorResponse(new Error('fail'));
    const parsed = JSON.parse(resp.content[0].text!);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message', 'fail');
  });

  test('handles non-Error input', () => {
    const resp = createErrorResponse('plain string');
    expect(resp.isError).toBe(true);
    const parsed = JSON.parse(resp.content[0].text!);
    expect(parsed.error.message).toContain('plain string');
  });

  test('handles MCPError input preserving code', () => {
    const err = new MCPError(MCPErrorCode.AUTHENTICATION_ERROR, 'no auth');
    const resp = createErrorResponse(err, 'tool');
    const parsed = JSON.parse(resp.content[0].text!);
    expect(parsed.error.code).toBe(MCPErrorCode.AUTHENTICATION_ERROR);
  });
});

// ── withErrorHandling ────────────────────────────────────────────────────────

describe('withErrorHandling', () => {
  test('success passthrough: returns the resolved value', async () => {
    const fn = async (x: number) => x * 2;
    const wrapped = withErrorHandling(fn, 'double');
    await expect(wrapped(5)).resolves.toBe(10);
  });

  test('wraps thrown errors into MCPError', async () => {
    const fn = async () => { throw new Error('inner'); };
    const wrapped = withErrorHandling(fn, 'ctx');
    await expect(wrapped()).rejects.toBeInstanceOf(MCPError);
    await expect(wrapped()).rejects.toMatchObject({ message: 'inner' });
  });

  test('passes through MCPError without double-wrapping', async () => {
    const original = new MCPError(MCPErrorCode.VALIDATION_ERROR, 'val');
    const fn = async () => { throw original; };
    const wrapped = withErrorHandling(fn);
    try {
      await wrapped();
      fail('should have thrown');
    } catch (e) {
      expect(e).toBe(original);
    }
  });
});

// ── handleConfigurationError ─────────────────────────────────────────────────

describe('handleConfigurationError', () => {
  test('throws MCPError with CONFIGURATION_ERROR code for Error input', () => {
    expect(() => handleConfigurationError(new Error('bad config')))
      .toThrow(MCPError);

    try {
      handleConfigurationError(new Error('bad config'));
    } catch (e) {
      const err = e as MCPError;
      expect(err.code).toBe(MCPErrorCode.CONFIGURATION_ERROR);
      expect(err.message).toContain('bad config');
    }
  });

  test('throws MCPError for non-Error input', () => {
    expect(() => handleConfigurationError('string')).toThrow(MCPError);

    try {
      handleConfigurationError(999);
    } catch (e) {
      const err = e as MCPError;
      expect(err.code).toBe(MCPErrorCode.CONFIGURATION_ERROR);
      expect(err.message).toContain('Unknown configuration error');
    }
  });
});

// ── handleExternalServiceError ───────────────────────────────────────────────

describe('handleExternalServiceError', () => {
  test('returns MCPError with EXTERNAL_SERVICE_ERROR code for Error input', () => {
    const result = handleExternalServiceError(new Error('timeout'), 'DebuggAI', 'getTest');
    expect(result).toBeInstanceOf(MCPError);
    expect(result.code).toBe(MCPErrorCode.EXTERNAL_SERVICE_ERROR);
    expect(result.message).toContain('DebuggAI');
    expect(result.message).toContain('timeout');
    expect(result.data).toMatchObject({
      serviceName: 'DebuggAI',
      operation: 'getTest',
    });
  });

  test('returns MCPError for non-Error input', () => {
    const result = handleExternalServiceError('nope', 'SomeAPI');
    expect(result).toBeInstanceOf(MCPError);
    expect(result.code).toBe(MCPErrorCode.EXTERNAL_SERVICE_ERROR);
    expect(result.message).toContain('SomeAPI');
    expect(result.message).toContain('nope');
  });

  test('omits operation from context when not supplied', () => {
    const result = handleExternalServiceError(new Error('err'), 'API');
    expect(result.data.operation).toBeUndefined();
  });
});

// ── isRetryableError ─────────────────────────────────────────────────────────

describe('isRetryableError', () => {
  test('EXTERNAL_SERVICE_ERROR is retryable', () => {
    const err = new MCPError(MCPErrorCode.EXTERNAL_SERVICE_ERROR, 'svc');
    expect(isRetryableError(err)).toBe(true);
  });

  test('INTERNAL_ERROR is retryable', () => {
    const err = new MCPError(MCPErrorCode.INTERNAL_ERROR, 'internal');
    expect(isRetryableError(err)).toBe(true);
  });

  test('AUTHENTICATION_ERROR is not retryable', () => {
    const err = new MCPError(MCPErrorCode.AUTHENTICATION_ERROR, 'auth');
    expect(isRetryableError(err)).toBe(false);
  });

  test('VALIDATION_ERROR is not retryable', () => {
    const err = new MCPError(MCPErrorCode.VALIDATION_ERROR, 'val');
    expect(isRetryableError(err)).toBe(false);
  });

  test('CONFIGURATION_ERROR is not retryable', () => {
    const err = new MCPError(MCPErrorCode.CONFIGURATION_ERROR, 'cfg');
    expect(isRetryableError(err)).toBe(false);
  });
});

// ── createAuthenticationError ────────────────────────────────────────────────

describe('createAuthenticationError', () => {
  test('returns MCPError with AUTHENTICATION_ERROR code', () => {
    const err = createAuthenticationError('bad token');
    expect(err).toBeInstanceOf(MCPError);
    expect(err.code).toBe(MCPErrorCode.AUTHENTICATION_ERROR);
    expect(err.message).toBe('bad token');
    expect(err.data).toMatchObject({ type: 'authentication' });
  });

  test('uses default message when none provided', () => {
    const err = createAuthenticationError();
    expect(err.message).toBe('Authentication failed');
  });
});
