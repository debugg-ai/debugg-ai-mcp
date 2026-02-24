/**
 * Comprehensive type definitions for DebuggAI MCP Server
 */

import { z } from 'zod';
import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Tool input validation schemas
 */
export const TestPageChangesInputSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  url: z.string().url('Must be a valid URL').optional(),
  localPort: z.number().int().min(1).max(65535).optional(),
  // Credential/environment resolution
  environmentId: z.string().uuid().optional(),
  credentialId: z.string().uuid().optional(),
  credentialRole: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
}).refine(
  (data) => data.url !== undefined || data.localPort !== undefined,
  { message: 'Provide a target via "url" (e.g. "https://example.com") or "localPort" for a local dev server' }
);

export type TestPageChangesInput = z.infer<typeof TestPageChangesInputSchema>;

/**
 * Tool execution context
 */
export interface ToolContext {
  progressToken?: string;
  requestId?: string;
  timestamp: Date;
}

/**
 * Enhanced tool request with typed arguments
 */
export interface TypedCallToolRequest<T = any> extends Omit<CallToolRequest, 'params'> {
  params: {
    name: string;
    arguments: T;
    _meta?: {
      progressToken?: string;
    };
  };
}

/**
 * Tool handler function type
 */
export type ToolHandler<TInput = any, TOutput = any> = (
  input: TInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
) => Promise<TOutput>;

/**
 * Tool definition with validation
 */
export interface ValidatedTool {
  name: string;
  description?: string;
  inputSchema: z.ZodSchema;
  handler: ToolHandler;
}

/**
 * Progress notification types
 */
export interface ProgressUpdate {
  progress: number;
  total: number;
  message?: string;
}

export type ProgressCallback = (update: ProgressUpdate) => Promise<void>;

/**
 * Error types
 */
export enum MCPErrorCode {
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
  PARSE_ERROR = -32700,
  // Custom error codes
  VALIDATION_ERROR = -32000,
  CONFIGURATION_ERROR = -32001,
  AUTHENTICATION_ERROR = -32002,
  EXTERNAL_SERVICE_ERROR = -32003,
}

export class MCPError extends Error {
  constructor(
    public code: MCPErrorCode,
    message: string,
    public data?: any
  ) {
    super(message);
    this.name = 'MCPError';
  }
}

/**
 * Tool response types
 */
export interface ToolResponse {
  content: Array<{
    type: 'text' | 'image';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * Server configuration types (re-exported from config)
 */
export type { Config } from '../config/index.js';

/**
 * Logging types
 */
export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

export interface LogContext {
  requestId?: string;
  toolName?: string;
  userId?: string;
  [key: string]: any;
}
