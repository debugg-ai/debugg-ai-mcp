/**
 * Centralized configuration management for DebuggAI MCP Server
 */

import { z } from 'zod';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

function findPackageVersion(): string {
  const __dir = dirname(fileURLToPath(import.meta.url));
  let dir = __dir;
  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      if (pkg.name === '@debugg-ai/debugg-ai-mcp') return pkg.version as string;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
}

const _version = findPackageVersion();

const configSchema = z.object({
  server: z.object({
    name: z.string().default('DebuggAI MCP Server'),
    version: z.string(),
  }),
  api: z.object({
    key: z.string().min(1, 'API key is required (set DEBUGGAI_API_KEY)'),
    tokenType: z.enum(['token', 'bearer']).default('token'),
    baseUrl: z.string().url().default('https://api.debugg.ai'),
  }),
  defaults: z.object({
    localPort: z.number().int().min(1).max(65535).optional(),
    repoName: z.string().optional(),
    branchName: z.string().optional(),
    repoPath: z.string().optional(),
    filePath: z.string().optional(),
  }),
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    format: z.enum(['json', 'simple']).default('simple'),
  }),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const rawConfig = {
    server: {
      name: 'DebuggAI MCP Server',
      version: _version,
    },
    api: {
      // Priority: DEBUGGAI_API_TOKEN → DEBUGGAI_JWT_TOKEN → DEBUGGAI_API_KEY
      key: process.env.DEBUGGAI_API_TOKEN || process.env.DEBUGGAI_JWT_TOKEN || process.env.DEBUGGAI_API_KEY || '',
      tokenType: (process.env.DEBUGGAI_TOKEN_TYPE as 'token' | 'bearer') || 'token',
      baseUrl: process.env.DEBUGGAI_API_URL || 'https://api.debugg.ai',
    },
    defaults: {
      localPort: process.env.DEBUGGAI_LOCAL_PORT ? parseInt(process.env.DEBUGGAI_LOCAL_PORT, 10) : undefined,
      repoName: process.env.DEBUGGAI_LOCAL_REPO_NAME || undefined,
      branchName: process.env.DEBUGGAI_LOCAL_BRANCH_NAME || undefined,
      repoPath: process.env.DEBUGGAI_LOCAL_REPO_PATH || undefined,
      filePath: process.env.DEBUGGAI_LOCAL_FILE_PATH || undefined,
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

let _config: Config | undefined;

export const config = {
  get server() { return getConfig().server; },
  get api() { return getConfig().api; },
  get defaults() { return getConfig().defaults; },
  get logging() { return getConfig().logging; }
};

function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
