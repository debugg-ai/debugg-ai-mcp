/**
 * Input validation utilities using Zod schemas
 * Provides consistent validation across all tools
 */

import { z } from 'zod';
import { MCPError, MCPErrorCode } from '../types/index.js';
import { Logger } from './logger.js';

const logger = new Logger({ module: 'validation' });

/**
 * Validate input against a Zod schema
 */
export function validateInput<T>(
  schema: z.ZodSchema<T>, 
  input: unknown, 
  toolName?: string
): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const validationErrors = error.errors.map(err => ({
        path: err.path.join('.'),
        message: err.message,
        code: err.code,
      }));

      logger.error('Input validation failed', { 
        toolName,
        validationErrors,
        input: typeof input === 'object' ? JSON.stringify(input) : input 
      });

      throw new MCPError(
        MCPErrorCode.VALIDATION_ERROR,
        `Input validation failed: ${validationErrors.map(e => `${e.path}: ${e.message}`).join(', ')}`,
        { validationErrors }
      );
    }

    logger.error('Unexpected validation error', { toolName, error: error instanceof Error ? error.message : String(error) });
    throw new MCPError(
      MCPErrorCode.INTERNAL_ERROR,
      'Unexpected validation error occurred',
      { originalError: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Validate environment variables
 */
export function validateEnvironment(requiredVars: string[]): void {
  const missing: string[] = [];
  
  for (const varName of requiredVars) {
    if (!process.env[varName] || process.env[varName]?.trim() === '') {
      missing.push(varName);
    }
  }

  if (missing.length > 0) {
    logger.error('Missing required environment variables', { missing });
    throw new MCPError(
      MCPErrorCode.CONFIGURATION_ERROR,
      `Missing required environment variables: ${missing.join(', ')}`,
      { missing }
    );
  }
}

/**
 * Common validation schemas
 */
export const commonSchemas = {
  port: z.number().int().min(1).max(65535),
  url: z.string().url(),
  filepath: z.string().min(1),
  repoName: z.string().min(1),
  branchName: z.string().min(1),
  progressToken: z.string().uuid().optional(),
  description: z.string().min(1, 'Description cannot be empty'),
} as const;

/**
 * Sanitize file paths for security
 */
export function sanitizeFilePath(filePath: string): string {
  // Basic path sanitization - remove dangerous patterns
  const sanitized = filePath
    .replace(/\.\./g, '') // Remove directory traversal
    .replace(/[<>:"|?*]/g, '') // Remove invalid file characters
    .replace(/\/+/g, '/') // Replace multiple slashes with single slash
    .replace(/^\/+/, '') // Remove leading slashes
    .trim();

  if (!sanitized) {
    throw new MCPError(
      MCPErrorCode.VALIDATION_ERROR,
      'Invalid file path provided',
      { originalPath: filePath }
    );
  }

  return sanitized;
}

/**
 * Validate port number
 */
export function validatePort(port: unknown): number {
  try {
    return commonSchemas.port.parse(port);
  } catch (error) {
    throw new MCPError(
      MCPErrorCode.VALIDATION_ERROR,
      `Invalid port number: ${port}. Port must be between 1 and 65535.`,
      { port }
    );
  }
}