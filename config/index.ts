/**
 * Centralized configuration management for DebuggAI MCP Server
 * Handles environment variable validation and default values
 */

import { z } from 'zod';

/**
 * Configuration schema with validation
 */
const configSchema = z.object({
  server: z.object({
    name: z.string().default('DebuggAI MCP Server'),
    version: z.string().default('0.1.1'),
  }),
  api: z.object({
    key: z.string().min(1, 'DEBUGGAI_API_KEY is required'),
    baseUrl: z.string().url().optional(),
  }),
  auth: z.object({
    testUsername: z.string().optional(),
    testPassword: z.string().optional(),
  }),
  defaults: z.object({
    localPort: z.number().int().min(1).max(65535).optional(),
    repoName: z.string().optional(),
    branchName: z.string().optional(),
    repoPath: z.string().optional(),
    filePath: z.string().optional(),
  }),
  urlPatterns: z.object({
    customPatterns: z.record(z.array(z.string())).optional(),
    customKeywords: z.record(z.array(z.string())).optional(),
    enableIntelligence: z.boolean().default(true),
  }).optional(),
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    format: z.enum(['json', 'simple']).default('simple'),
  }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): Config {
  const rawConfig = {
    server: {
      name: 'DebuggAI MCP Server',
      version: '0.1.1',
    },
    api: {
      key: process.env.DEBUGGAI_API_KEY || '',
      baseUrl: process.env.DEBUGGAI_API_BASE_URL,
    },
    auth: {
      testUsername: process.env.TEST_USERNAME_EMAIL || '',
      testPassword: process.env.TEST_USER_PASSWORD || '',
    },
    defaults: {
      localPort: process.env.DEBUGGAI_LOCAL_PORT ? parseInt(process.env.DEBUGGAI_LOCAL_PORT, 10) : undefined,
      repoName: process.env.DEBUGGAI_LOCAL_REPO_NAME || undefined,
      branchName: process.env.DEBUGGAI_LOCAL_BRANCH_NAME || undefined,
      repoPath: process.env.DEBUGGAI_LOCAL_REPO_PATH || undefined,
      filePath: process.env.DEBUGGAI_LOCAL_FILE_PATH || undefined,
    },
    urlPatterns: {
      customPatterns: process.env.DEBUGGAI_URL_PATTERNS ? JSON.parse(process.env.DEBUGGAI_URL_PATTERNS) : undefined,
      customKeywords: process.env.DEBUGGAI_URL_KEYWORDS ? JSON.parse(process.env.DEBUGGAI_URL_KEYWORDS) : undefined,
      enableIntelligence: process.env.DEBUGGAI_URL_INTELLIGENCE === 'false' ? false : true,
    },
    logging: {
      level: (process.env.LOG_LEVEL as any) || 'info',
      format: (process.env.LOG_FORMAT as any) || 'simple',
    },
  };

  try {
    return configSchema.parse(rawConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingFields = error.errors
        .map(err => `${err.path.join('.')}: ${err.message}`)
        .join(', ');
      throw new Error(`Configuration validation failed: ${missingFields}`);
    }
    throw error;
  }
}

/**
 * Global configuration instance - loaded lazily to avoid import-time errors in tests
 */
let _config: Config | undefined;

export const config = {
  get server() { return getConfig().server; },
  get api() { return getConfig().api; },
  get auth() { return getConfig().auth; },
  get defaults() { return getConfig().defaults; },
  get urlPatterns() { return getConfig().urlPatterns; },
  get logging() { return getConfig().logging; }
};

function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}