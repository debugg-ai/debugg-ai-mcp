/**
 * Centralized error handling utilities
 * Provides consistent error responses and MCP error codes
 */

import { MCPError, MCPErrorCode, ToolResponse } from '../types/index.js';
import { Logger } from './logger.js';

const logger = new Logger({ module: 'error-handler' });

/**
 * Convert any error to a standardized MCP error
 */
export function toMCPError(error: unknown, context?: string): MCPError {
  if (error instanceof MCPError) {
    return error;
  }

  if (error instanceof Error) {
    logger.error('Converting standard error to MCP error', { 
      message: error.message,
      stack: error.stack,
      context 
    });

    return new MCPError(
      MCPErrorCode.INTERNAL_ERROR,
      error.message,
      { 
        originalError: error.name,
        context,
        stack: error.stack 
      }
    );
  }

  const errorMessage = String(error);
  logger.error('Converting unknown error to MCP error', { error: errorMessage, context });

  return new MCPError(
    MCPErrorCode.INTERNAL_ERROR,
    `Unknown error occurred: ${errorMessage}`,
    { originalError: errorMessage, context }
  );
}

/**
 * Create error response for tool execution
 */
export function createErrorResponse(error: unknown, toolName?: string): ToolResponse {
  const mcpError = toMCPError(error, toolName);
  
  logger.error('Tool execution failed', {
    toolName,
    errorCode: mcpError.code,
    message: mcpError.message,
    data: mcpError.data
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: mcpError.code,
            message: mcpError.message,
            data: mcpError.data
          }
        }, null, 2)
      }
    ]
  };
}

/**
 * Wrap async function with error handling
 */
export function withErrorHandling<T extends any[], R>(
  fn: (...args: T) => Promise<R>,
  context?: string
) {
  return async (...args: T): Promise<R> => {
    try {
      return await fn(...args);
    } catch (error) {
      throw toMCPError(error, context);
    }
  };
}

/**
 * Handle configuration errors specifically
 */
export function handleConfigurationError(error: unknown): never {
  if (error instanceof Error) {
    logger.error('Configuration error', { message: error.message });
    throw new MCPError(
      MCPErrorCode.CONFIGURATION_ERROR,
      `Configuration error: ${error.message}`,
      { originalError: error.message }
    );
  }

  logger.error('Unknown configuration error', { error });
  throw new MCPError(
    MCPErrorCode.CONFIGURATION_ERROR,
    'Unknown configuration error occurred',
    { originalError: String(error) }
  );
}

/**
 * Handle external service errors (e.g., API calls)
 */
export function handleExternalServiceError(
  error: unknown, 
  serviceName: string,
  operation?: string
): MCPError {
  const context = `${serviceName}${operation ? `:${operation}` : ''}`;
  
  if (error instanceof Error) {
    logger.error('External service error', { 
      serviceName, 
      operation, 
      message: error.message 
    });

    return new MCPError(
      MCPErrorCode.EXTERNAL_SERVICE_ERROR,
      `${serviceName} error: ${error.message}`,
      { 
        serviceName, 
        operation, 
        originalError: error.message 
      }
    );
  }

  logger.error('Unknown external service error', { serviceName, operation, error });
  return new MCPError(
    MCPErrorCode.EXTERNAL_SERVICE_ERROR,
    `${serviceName} error: ${String(error)}`,
    { serviceName, operation, originalError: String(error) }
  );
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: MCPError): boolean {
  const retryableCodes = [
    MCPErrorCode.EXTERNAL_SERVICE_ERROR,
    MCPErrorCode.INTERNAL_ERROR,
  ];
  
  return retryableCodes.includes(error.code);
}

/**
 * Create authentication error
 */
export function createAuthenticationError(message?: string): MCPError {
  return new MCPError(
    MCPErrorCode.AUTHENTICATION_ERROR,
    message || 'Authentication failed',
    { type: 'authentication' }
  );
}