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
  localPort: z.number().int().min(1).max(65535).optional(),
  filePath: z.string().optional(),
  repoName: z.string().optional(),
  branchName: z.string().optional(),
  repoPath: z.string().optional(),
  targetUrl: z.string().optional(), // Optional explicit URL override
});

export type TestPageChangesInput = z.infer<typeof TestPageChangesInputSchema>;

/**
 * E2E Suite Tool Schemas
 */
export const ListTestsInputSchema = z.object({
  repoName: z.string().optional(),
  branchName: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
  page: z.number().int().positive().optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export const ListTestSuitesInputSchema = z.object({
  repoName: z.string().optional(),
  branchName: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
  page: z.number().int().positive().optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export const CreateTestSuiteInputSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  repoName: z.string().optional(),
  branchName: z.string().optional(),
  repoPath: z.string().optional(),
  filePath: z.string().optional(),
});

export const CreateCommitSuiteInputSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  repoName: z.string().optional(),
  branchName: z.string().optional(),
  repoPath: z.string().optional(),
  filePath: z.string().optional(),
});

export const ListCommitSuitesInputSchema = z.object({
  repoName: z.string().optional(),
  branchName: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
  page: z.number().int().positive().optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export const GetTestStatusInputSchema = z.object({
  suiteUuid: z.string().uuid('Invalid suite UUID'),
  suiteType: z.enum(['test', 'commit']).optional().default('test'),
});

/**
 * Live Session Tool Schemas
 */
export const StartLiveSessionInputSchema = z.object({
  url: z.string().min(1, 'URL is required').refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    'URL must be a valid HTTP or HTTPS URL'
  ),
  localPort: z.number().int().min(1).max(65535).optional(),
  sessionName: z.string().max(100).optional(),
  monitorConsole: z.boolean().optional().default(true),
  monitorNetwork: z.boolean().optional().default(true),
  takeScreenshots: z.boolean().optional().default(false),
  screenshotInterval: z.number().int().min(1).max(300).optional().default(10),
});

export const StopLiveSessionInputSchema = z.object({
  sessionId: z.string().optional(),
});

export const GetLiveSessionStatusInputSchema = z.object({
  sessionId: z.string().optional(),
});

export const GetLiveSessionLogsInputSchema = z.object({
  sessionId: z.string().optional(),
  logType: z.enum(['console', 'network', 'errors', 'all']).optional().default('all'),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(1000).optional().default(100),
});

export const GetLiveSessionScreenshotInputSchema = z.object({
  sessionId: z.string().optional(),
  fullPage: z.boolean().optional().default(false),
  quality: z.number().int().min(1).max(100).optional().default(90),
  format: z.enum(['png', 'jpeg']).optional().default('png'),
});

export const NavigateLiveSessionInputSchema = z.object({
  sessionId: z.string().optional(),
  target: z.string().min(1, 'Target URL or description is required'),
  preserveBaseUrl: z.boolean().optional().default(true),
});


// Input type inferences
export type ListTestsInput = z.infer<typeof ListTestsInputSchema>;
export type ListTestSuitesInput = z.infer<typeof ListTestSuitesInputSchema>;
export type CreateTestSuiteInput = z.infer<typeof CreateTestSuiteInputSchema>;
export type CreateCommitSuiteInput = z.infer<typeof CreateCommitSuiteInputSchema>;
export type ListCommitSuitesInput = z.infer<typeof ListCommitSuitesInputSchema>;
export type GetTestStatusInput = z.infer<typeof GetTestStatusInputSchema>;
export type StartLiveSessionInput = z.infer<typeof StartLiveSessionInputSchema>;
export type StopLiveSessionInput = z.infer<typeof StopLiveSessionInputSchema>;
export type GetLiveSessionStatusInput = z.infer<typeof GetLiveSessionStatusInputSchema>;
export type GetLiveSessionLogsInput = z.infer<typeof GetLiveSessionLogsInputSchema>;
export type GetLiveSessionScreenshotInput = z.infer<typeof GetLiveSessionScreenshotInputSchema>;
export type NavigateLiveSessionInput = z.infer<typeof NavigateLiveSessionInputSchema>;

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
}

/**
 * E2E Test related types
 */
export interface E2ETestResult {
  testOutcome?: string;
  testDetails?: string[];
  finalScreenshot?: string;
  runGif?: string;
  conversations?: Array<{
    messages: Array<{
      jsonContent?: {
        currentState?: {
          nextGoal?: string;
        };
      };
    }>;
  }>;
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

/**
 * URL Intelligence types
 */
export interface UrlPattern {
  pageType: string;
  patterns: string[];
  keywords?: string[];
}

export interface UrlResolutionResult {
  url: string;
  confidence: 'high' | 'medium' | 'low';
  pageType?: string;
  isExplicit: boolean;
}

export interface UrlConfiguration {
  patterns: Record<string, string[]>;
  keywords: Record<string, string[]>;
  parameterDefaults: Record<string, string[]>;
}

/**
 * Transport layer configuration types
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  exponentialBase: number;
  retryableStatusCodes: number[];
  retryableErrorCodes: MCPErrorCode[];
}

export interface CacheConfig {
  enabled: boolean;
  ttl: number; // Time to live in milliseconds
  maxSize: number; // Maximum number of cached entries
  excludePatterns: string[]; // URL patterns to exclude from caching
}

export interface MetricsConfig {
  enabled: boolean;
  collectTiming: boolean;
  collectErrors: boolean;
  collectCacheStats: boolean;
}

export interface TransportConfig {
  retry: RetryConfig;
  cache: CacheConfig;
  metrics: MetricsConfig;
  logging: {
    enabled: boolean;
    logRequests: boolean;
    logResponses: boolean;
    logErrors: boolean;
    sanitizeSensitiveData: boolean;
  };
}

/**
 * Request performance metrics
 */
export interface RequestMetrics {
  startTime: number;
  endTime?: number;
  duration?: number;
  method: string;
  url: string;
  statusCode?: number;
  cacheHit?: boolean;
  retryAttempt?: number;
  error?: string;
}

/**
 * Cache entry interface
 */
export interface CacheEntry<T = any> {
  data: T;
  timestamp: number;
  ttl: number;
  url: string;
  method: string;
}

/**
 * Transport metrics collection
 */
export interface TransportMetrics {
  totalRequests: number;
  totalErrors: number;
  totalCacheHits: number;
  totalCacheMisses: number;
  averageResponseTime: number;
  requestsByMethod: Record<string, number>;
  errorsByCode: Record<string, number>;
}