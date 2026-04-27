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

export const TriggerCrawlInputSchema = z.object({
  url: z.preprocess(
    normalizeUrl,
    z.string().url('Invalid URL. Pass a full URL like "http://localhost:3000" or "https://example.com". Localhost URLs are auto-tunneled to the remote browser.'),
  ),
  projectUuid: z.string().uuid().optional(),
  environmentId: z.string().uuid().optional(),
  credentialId: z.string().uuid().optional(),
  credentialRole: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  headless: z.boolean().optional(),
  timeoutSeconds: z.number().int().positive().max(1800, 'timeoutSeconds cannot exceed 1800 (30 min)').optional(),
  repoName: z.string().optional(),
}).strict();

export type TriggerCrawlInput = z.infer<typeof TriggerCrawlInputSchema>;

// ── New consolidated search schemas (bead ddq) ─────────────────────────────
// uuid and filter params are mutually exclusive: either look up one thing by
// uuid, or filter the collection. Mixing them is ambiguous.

export const SearchProjectsInputSchema = z.object({
  uuid: z.string().uuid().optional(),
  q: z.string().min(1).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
}).strict().refine(
  (v) => !(v.uuid && (v.q !== undefined)),
  { message: 'Cannot combine uuid with filter params (q). Pass one or the other.' },
);
export type SearchProjectsInput = z.infer<typeof SearchProjectsInputSchema>;

// projectUuid is a LOCATOR (required by the backend URL path for envs/creds), not a
// filter — so it's compatible with uuid mode. Only q and uuid are mutually exclusive.
export const SearchEnvironmentsInputSchema = z.object({
  uuid: z.string().uuid().optional(),
  projectUuid: z.string().uuid().optional(),
  q: z.string().min(1).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
}).strict().refine(
  (v) => !(v.uuid && v.q !== undefined),
  { message: 'Cannot combine uuid with q (they are mutually exclusive — uuid mode returns one env; q filters a list).' },
);
export type SearchEnvironmentsInput = z.infer<typeof SearchEnvironmentsInputSchema>;

export const SearchExecutionsInputSchema = z.object({
  uuid: z.string().uuid().optional(),
  projectUuid: z.string().uuid().optional(),
  status: z.string().min(1).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
}).strict().refine(
  (v) => !(v.uuid && (v.projectUuid || v.status)),
  { message: 'Cannot combine uuid with filter params (projectUuid, status).' },
);
export type SearchExecutionsInput = z.infer<typeof SearchExecutionsInputSchema>;

const CredentialSeedSchema = z.object({
  label: z.string().min(1, 'label is required'),
  username: z.string().min(1, 'username is required'),
  password: z.string().min(1, 'password is required'),
  role: z.string().min(1).optional(),
}).strict();

export const CreateEnvironmentInputSchema = z.object({
  name: z.string().min(1, 'name is required'),
  url: z.string().url('url is required for standard environments'),
  description: z.string().optional(),
  projectUuid: z.string().uuid().optional(),
  credentials: z.array(CredentialSeedSchema).optional(),
}).strict();
export type CreateEnvironmentInput = z.infer<typeof CreateEnvironmentInputSchema>;

const CredentialUpdateSchema = z.object({
  uuid: z.string().uuid(),
  label: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
}).strict();

export const UpdateEnvironmentInputSchema = z.object({
  uuid: z.string().uuid(),
  name: z.string().min(1).optional(),
  url: z.string().url().optional(),
  description: z.string().optional(),
  projectUuid: z.string().uuid().optional(),
  addCredentials: z.array(CredentialSeedSchema).optional(),
  updateCredentials: z.array(CredentialUpdateSchema).optional(),
  removeCredentialIds: z.array(z.string().uuid()).optional(),
}).strict();
export type UpdateEnvironmentInput = z.infer<typeof UpdateEnvironmentInputSchema>;

export const DeleteEnvironmentInputSchema = z.object({
  uuid: z.string().uuid(),
  projectUuid: z.string().uuid().optional(),
}).strict();
export type DeleteEnvironmentInput = z.infer<typeof DeleteEnvironmentInputSchema>;


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



export const CreateProjectInputSchema = z.object({
  name: z.string().min(1),
  platform: z.string().min(1),
  teamUuid: z.string().uuid().optional(),
  teamName: z.string().min(1).optional(),
  repoUuid: z.string().uuid().optional(),
  repoName: z.string().min(1).optional(),
}).strict()
  .refine((v) => !(v.teamUuid && v.teamName), {
    message: 'Provide teamUuid OR teamName, not both.',
  })
  .refine((v) => !(v.repoUuid && v.repoName), {
    message: 'Provide repoUuid OR repoName, not both.',
  })
  .refine((v) => v.teamUuid || v.teamName, {
    message: 'Must provide teamUuid or teamName.',
  })
  .refine((v) => v.repoUuid || v.repoName, {
    message: 'Must provide repoUuid or repoName.',
  });
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

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

// ── probe-page ────────────────────────────────────────────────────────────
// Lightweight no-LLM page-probe tool. Each target gets its own wait config;
// targets[] is the batch — one workflow execution covers up to 20 URLs sharing
// browser session + tunnel. Strict schema: forbidden agent fields like
// `description` and `credentialId` reject (zero-LLM contract).

export const ProbePageTargetSchema = z.object({
  url: z.preprocess(
    normalizeUrl,
    z.string().url('Invalid URL. Pass a full URL like "http://localhost:3000" or "https://example.com". Localhost URLs are auto-tunneled to the remote browser.'),
  ),
  waitForSelector: z.string().optional(),
  waitForLoadState: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
  timeoutMs: z.number().int().min(1000, 'timeoutMs minimum is 1000 (1s)').max(30000, 'timeoutMs maximum is 30000 (30s) — longer probes should use check_app_in_browser').default(10000),
}).strict();

export const ProbePageInputSchema = z.object({
  targets: z.array(ProbePageTargetSchema).min(1, 'targets must have at least one URL').max(20, 'targets capped at 20 per call — split larger sweeps across multiple calls'),
  includeHtml: z.boolean().default(false),
  captureScreenshots: z.boolean().default(true),
  repoName: z.string().optional(),
}).strict();

export type ProbePageTarget = z.infer<typeof ProbePageTargetSchema>;
export type ProbePageInput = z.infer<typeof ProbePageInputSchema>;

export interface NetworkSummaryEntry {
  url: string;
  count: number;
  statuses: Record<string, number>;
  totalBytes: number;
  mimeType?: string;
}

export interface ConsoleErrorEntry {
  level: string;
  text: string;
  source?: string;
  lineNumber?: number;
  timestamp?: number;
}

export interface ProbePageResult {
  url: string;
  finalUrl: string;
  statusCode: number;
  title: string | null;
  loadTimeMs: number;
  consoleErrors: ConsoleErrorEntry[];
  networkSummary: NetworkSummaryEntry[];
  html?: string;
  error?: string;
}

export interface ProbePageResponse {
  executionId: string;
  durationMs: number;
  results: ProbePageResult[];
}
