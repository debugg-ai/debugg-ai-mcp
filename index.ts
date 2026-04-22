#!/usr/bin/env node

/**
 * DebuggAI MCP Server - Modernized Architecture
 * 
 * This server provides AI-powered end-to-end testing capabilities through
 * the Model Context Protocol (MCP). It allows AI assistants to create,
 * execute, and monitor automated tests for web applications.
 * 
 * Features:
 * - Structured logging with Winston
 * - Input validation with Zod schemas
 * - Centralized configuration management
 * - Modular tool architecture
 * - Proper error handling with MCP error codes
 * - Progress reporting for long-running operations
 * 
 * @version 0.1.1
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config/index.js";
import { initTools, getTools, getTool } from "./tools/index.js";
import {
  Logger,
  validateInput,
  createErrorResponse,
  toMCPError,
  handleConfigurationError,
  Telemetry,
  TelemetryEvents,
} from "./utils/index.js";
import { 
  TypedCallToolRequest,
  ToolContext,
  ProgressCallback,
  MCPErrorCode 
} from "./types/index.js";

// Logger and server are initialized lazily in main() to avoid triggering
// config loading at module load time. If config validation fails (bad env vars),
// the error is caught by main()'s try-catch instead of crashing before any
// error handling is set up.
let logger: Logger;
let server: Server;

function createMCPServer(): Server {
  return new Server(
    {
      name: config.server.name,
      version: config.server.version,
      description: "AI-powered browser automation and E2E testing platform for web applications.",
    },
    {
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
    }
  );
}


/**
 * Create progress callback for tool execution
 */
function createProgressCallback(progressToken?: string): ProgressCallback | undefined {
  if (!progressToken) return undefined;

  return async ({ progress, total, message }) => {
    try {
      await server.notification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          total,
          message,
        },
      });
    } catch (error) {
      logger.warn('Failed to send progress notification', { 
        progressToken, 
        progress, 
        total, 
        message,
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  };
}

/**
 * Register MCP request handlers. Called in main() after server is created.
 */
function registerHandlers(): void {
  server.setRequestHandler(CallToolRequestSchema as any, async (req: any): Promise<any> => {
    const typedReq = req as CallToolRequest;
    const requestId = `req_${Date.now()}`;
    const requestLogger = logger.child({ requestId });

    requestLogger.info("Received tool call request", {
      toolName: typedReq.params.name,
      hasProgressToken: !!typedReq.params._meta?.progressToken,
      progressToken: typedReq.params._meta?.progressToken,
      progressTokenType: typeof typedReq.params._meta?.progressToken
    });

    const { name, arguments: args } = typedReq.params;
    const progressToken = typedReq.params._meta?.progressToken;

    const tool = getTool(name);
    if (!tool) {
      requestLogger.warn(`Tool not found: ${name}`);
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      const validatedInput = validateInput(tool.inputSchema, args, name);

      const context: ToolContext = {
        progressToken: typeof progressToken === 'string' ? progressToken : undefined,
        requestId,
        timestamp: new Date(),
      };

      const progressCallback = createProgressCallback(typeof progressToken === 'string' || typeof progressToken === 'number' ? String(progressToken) : undefined);

      requestLogger.info(`Executing tool: ${name}`);
      const toolStart = Date.now();
      const result = await tool.handler(validatedInput, context, progressCallback);

      const toolDuration = Date.now() - toolStart;
      requestLogger.info(`Tool execution completed: ${name}`);
      Telemetry.capture(TelemetryEvents.TOOL_EXECUTED, { toolName: name, durationMs: toolDuration, success: true });
      return result;

    } catch (error) {
      const mcpError = toMCPError(error, 'tool execution');
      requestLogger.error('Tool execution failed', {
        errorCode: mcpError.code,
        message: mcpError.message,
        data: mcpError.data
      });
      Telemetry.capture(TelemetryEvents.TOOL_FAILED, { toolName: name, errorCode: mcpError.code });

      return createErrorResponse(mcpError, typedReq.params.name);
    }
  });

  server.setRequestHandler(ListToolsRequestSchema as any, async (): Promise<any> => {
    const tools = getTools();
    logger.info('Tools list requested', { toolCount: tools.length });
    return { tools };
  });
}

/**
 * Main server initialization and startup
 */
async function main(): Promise<void> {
  try {
    // Initialize logger and server here (not at module load time) so config
    // validation errors are caught by this try-catch instead of crashing.
    logger = new Logger({ module: 'main' });
    server = createMCPServer();

    // Register request handlers (they reference the `server` variable)
    registerHandlers();

    logger.info('Starting DebuggAI MCP Server', {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      pid: process.pid
    });

    // Validate required environment variables
    if (!config.api.key) {
      throw new Error(
        'Missing required environment variable: DEBUGGAI_API_KEY'
      );
    }

    // Initialize telemetry (PostHog when key is set, Noop otherwise)
    Telemetry.setDistinctId(config.api.key);
    if (config.telemetry.posthogApiKey) {
      const { PostHogProvider } = await import('./services/posthogProvider.js');
      Telemetry.configure(new PostHogProvider(config.telemetry.posthogApiKey, {
        host: config.telemetry.posthogHost,
      }));
      logger.info('Telemetry enabled (PostHog)');
    }

    // No API calls at boot. Project context is resolved lazily on first tool
    // invocation (list_environments / list_credentials / check_app_in_browser).
    initTools(null);
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('DebuggAI MCP Server is running and ready to accept requests', {
      transport: 'stdio',
      toolsAvailable: getTools().map(t => t.name),
    });

  } catch (error) {
    logger.error('Failed to start DebuggAI MCP Server', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    throw handleConfigurationError(error);
  }
}

/**
 * Safe log helper — falls back to stderr if logger isn't initialized yet
 * (e.g. config validation failed before logger was created).
 */
function safeLog(level: 'info' | 'error' | 'warn', message: string, meta?: any): void {
  try {
    if (logger) {
      logger[level](message, meta);
      return;
    }
  } catch {
    // Logger init failed (config validation error) — fall through to stderr
  }
  process.stderr.write(`[${level.toUpperCase()}] ${message} ${meta ? JSON.stringify(meta) : ''}\n`);
}

/**
 * Handle graceful shutdown
 */
async function gracefulShutdown(signal: string): Promise<void> {
  safeLog('info', `Received ${signal}, shutting down gracefully`);
  const { tunnelManager } = await import('./services/ngrok/tunnelManager.js');
  await tunnelManager.stopAllTunnels().catch((err) =>
    safeLog('warn', 'stopAllTunnels failed during shutdown', { error: String(err) }),
  );
  await Telemetry.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });

process.on('unhandledRejection', (reason) => {
  safeLog('error', 'Unhandled promise rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (error) => {
  safeLog('error', 'Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
});

/**
 * Start the server
 */
main().catch((error) => {
  safeLog('error', 'Fatal error during startup', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
