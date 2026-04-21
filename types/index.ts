/**
 * Comprehensive type definitions for DebuggAI MCP Server
 */

import { z } from 'zod';
import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { normalizeUrl } from '../utils/urlParser.js';

/**
 * Tool input validation schemas
 */
export const TestPageChangesInputSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  url: z.preprocess(
    normalizeUrl,
    z.string().url('Invalid URL. Pass a full URL like "http://localhost:3000" or "https://example.com". Localhost URLs are auto-tunneled to the remote browser — no extra setup needed.')
  ),
  // Credential/environment resolution
  environmentId: z.string().uuid().optional(),
  credentialId: z.string().uuid().optional(),
  credentialRole: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  repoName: z.string().optional(),
});

export type TestPageChangesInput = z.infer<typeof TestPageChangesInputSchema>;

export const ListEnvironmentsInputSchema = z.object({
  projectUuid: z.string().uuid().optional(),
  q: z.string().min(1).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
}).strict();
export type ListEnvironmentsInput = z.infer<typeof ListEnvironmentsInputSchema>;

export const CreateEnvironmentInputSchema = z.object({
  name: z.string().min(1, 'name is required'),
  url: z.string().url('url is required for standard environments'),
  description: z.string().optional(),
  projectUuid: z.string().uuid().optional(),
}).strict();
export type CreateEnvironmentInput = z.infer<typeof CreateEnvironmentInputSchema>;

export const GetEnvironmentInputSchema = z.object({
  uuid: z.string().uuid(),
  projectUuid: z.string().uuid().optional(),
}).strict();
export type GetEnvironmentInput = z.infer<typeof GetEnvironmentInputSchema>;

export const UpdateEnvironmentInputSchema = z.object({
  uuid: z.string().uuid(),
  name: z.string().min(1).optional(),
  url: z.string().url().optional(),
  description: z.string().optional(),
  projectUuid: z.string().uuid().optional(),
}).strict();
export type UpdateEnvironmentInput = z.infer<typeof UpdateEnvironmentInputSchema>;

export const DeleteEnvironmentInputSchema = z.object({
  uuid: z.string().uuid(),
  projectUuid: z.string().uuid().optional(),
}).strict();
export type DeleteEnvironmentInput = z.infer<typeof DeleteEnvironmentInputSchema>;

export const GetCredentialInputSchema = z.object({
  uuid: z.string().uuid(),
  environmentId: z.string().uuid(),
  projectUuid: z.string().uuid().optional(),
}).strict();
export type GetCredentialInput = z.infer<typeof GetCredentialInputSchema>;

export const UpdateCredentialInputSchema = z.object({
  uuid: z.string().uuid(),
  environmentId: z.string().uuid(),
  label: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  projectUuid: z.string().uuid().optional(),
}).strict();
export type UpdateCredentialInput = z.infer<typeof UpdateCredentialInputSchema>;

export const DeleteCredentialInputSchema = z.object({
  uuid: z.string().uuid(),
  environmentId: z.string().uuid(),
  projectUuid: z.string().uuid().optional(),
}).strict();
export type DeleteCredentialInput = z.infer<typeof DeleteCredentialInputSchema>;

export const GetProjectInputSchema = z.object({
  uuid: z.string().uuid(),
}).strict();
export type GetProjectInput = z.infer<typeof GetProjectInputSchema>;

export const UpdateProjectInputSchema = z.object({
  uuid: z.string().uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
}).strict();
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

export const DeleteProjectInputSchema = z.object({
  uuid: z.string().uuid(),
}).strict();
export type DeleteProjectInput = z.infer<typeof DeleteProjectInputSchema>;

export const ListExecutionsInputSchema = z.object({
  status: z.string().min(1).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
}).strict();
export type ListExecutionsInput = z.infer<typeof ListExecutionsInputSchema>;

export const GetExecutionInputSchema = z.object({
  uuid: z.string().uuid(),
}).strict();
export type GetExecutionInput = z.infer<typeof GetExecutionInputSchema>;

export const CancelExecutionInputSchema = z.object({
  uuid: z.string().uuid(),
}).strict();
export type CancelExecutionInput = z.infer<typeof CancelExecutionInputSchema>;

export const ListCredentialsInputSchema = z.object({
  environmentId: z.string().uuid().optional(),
  projectUuid: z.string().uuid().optional(),
  q: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
}).strict();
export type ListCredentialsInput = z.infer<typeof ListCredentialsInputSchema>;

export const CreateCredentialInputSchema = z.object({
  environmentId: z.string().uuid(),
  label: z.string().min(1, 'label is required'),
  username: z.string().min(1, 'username is required'),
  password: z.string().min(1, 'password is required'),
  role: z.string().min(1).optional(),
  projectUuid: z.string().uuid().optional(),
}).strict();
export type CreateCredentialInput = z.infer<typeof CreateCredentialInputSchema>;

export const ListProjectsInputSchema = z.object({
  q: z.string().min(1).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
}).strict();
export type ListProjectsInput = z.infer<typeof ListProjectsInputSchema>;

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
