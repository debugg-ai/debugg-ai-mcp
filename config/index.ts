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

/**
 * Public PostHog project key (write-only). Embedded so every MCP install
 * sends telemetry by default — lets the team observe cache hit rates,
 * poll cadence, tunnel reliability, etc. across the whole install base
 * without requiring users to configure anything.
 *
 * Safe to embed: this is a `phc_*` project key (PostHog's client-side
 * convention), not a personal API key. It can only write events, not
 * read them.
 *
 * Override with POSTHOG_API_KEY (e.g. for a private fork pointing at a
 * different PostHog project). Disable with DEBUGGAI_TELEMETRY_DISABLED=1.
 */
const DEBUGGAI_DEFAULT_POSTHOG_KEY = 'phc_4h2Yov2P0Vc9UMqfKf3dYKSQ6THOs7N6LZR0VKYopZN';

function isTelemetryDisabled(): boolean {
  const v = (process.env.DEBUGGAI_TELEMETRY_DISABLED || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function resolvePosthogKey(): string | undefined {
  if (isTelemetryDisabled()) return undefined;
  return process.env.POSTHOG_API_KEY || DEBUGGAI_DEFAULT_POSTHOG_KEY;
}

const configSchema = z.object({
  server: z.object({
    name: z.string().default('DebuggAI MCP Server'),
    version: z.string(),
  }),
  api: z.object({
    // key is validated at tool-call time (not at boot) so MCP clients can surface
    // a proper error message instead of seeing the subprocess die → "Failed to
    // reconnect". See bead cma + flow 25.
    key: z.string(),
    tokenType: z.enum(['token', 'bearer']).default('token'),
    baseUrl: z.string().url().default('https://api.debugg.ai'),
  }),
  defaults: z.object({}),
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    format: z.enum(['json', 'simple']).default('simple'),
  }),
  telemetry: z.object({
    posthogApiKey: z.string().optional(),
    posthogHost: z.string().optional(),
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
    defaults: {},
    logging: {
      level: (process.env.LOG_LEVEL as any) || 'info',
      format: (process.env.LOG_FORMAT as any) || 'simple',
    },
    telemetry: {
      posthogApiKey: resolvePosthogKey(),
      posthogHost: process.env.POSTHOG_HOST || undefined,
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
  get logging() { return getConfig().logging; },
  get telemetry() { return getConfig().telemetry; },
};

function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
