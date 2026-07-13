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
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config/index.js";
import { initTools, getTools, getTool } from "./tools/index.js";
import { readResource, RESOURCE_COLLECTIONS, RESOURCE_TEMPLATES } from "./handlers/resourcesHandler.js";
import {
  Logger,
  validateInput,
  createErrorResponse,
  toMCPError,
  handleConfigurationError,
  Telemetry,
  TelemetryEvents,
  withStructuredContent,
} from "./utils/index.js";
import {
  ToolContext,
  ProgressCallback,
  MCPErrorCode,
  MCPError,
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
        resources: {
          listChanged: false,
        },
      },
    }
  );
}


/**
 * Create progress callback for tool execution
 */
function createProgressCallback(srv: Server, progressToken?: string): ProgressCallback | undefined {
  if (!progressToken) return undefined;

  return async ({ progress, total, message }) => {
    try {
      await srv.notification({
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
 * Build a fully-configured MCP Server (capabilities + all request handlers).
 * The HTTP transport calls this once per request for stateless isolation; main()
 * uses it for the long-lived stdio server.
 */
export function buildConfiguredServer(): Server {
  const srv = createMCPServer();
  registerHandlers(srv);
  return srv;
}

/**
 * Register MCP request handlers on a server instance. Called for the stdio
 * singleton in main(), and once per request by the HTTP transport (stateless).
 */
function registerHandlers(srv: Server): void {
  srv.setRequestHandler(CallToolRequestSchema as any, async (req: any, extra: any): Promise<any> => {
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

    // Deferred config validation (bead cma): if DEBUGGAI_API_KEY is missing,
    // return a structured error MCP clients can surface in their UI — instead
    // of letting the backend return a cryptic 401.
    if (!config.api.key) {
      const mcpError = new MCPError(
        MCPErrorCode.CONFIGURATION_ERROR,
        'DEBUGGAI_API_KEY is not set. ' +
        'Configure it in your MCP server registration (e.g. `claude mcp add debugg-ai -s user -e DEBUGGAI_API_KEY=<your-key> -- npx -y @debugg-ai/debugg-ai-mcp`). ' +
        'Get a key at https://debugg.ai.',
        { missingEnvVars: ['DEBUGGAI_API_KEY'] },
      );
      requestLogger.warn('Tool call blocked — DEBUGGAI_API_KEY missing', { tool: name });
      return createErrorResponse(mcpError, name);
    }

    try {
      const validatedInput = validateInput(tool.inputSchema, args, name);

      const context: ToolContext = {
        progressToken: typeof progressToken === 'string' ? progressToken : undefined,
        requestId,
        timestamp: new Date(),
        // Cancellation source for long-running handlers: the SDK aborts this
        // signal when the client cancels the call or the transport closes.
        signal: extra?.signal,
      };

      const progressCallback = createProgressCallback(srv, typeof progressToken === 'string' || typeof progressToken === 'number' ? String(progressToken) : undefined);

      requestLogger.info(`Executing tool: ${name}`);
      const toolStart = Date.now();
      const result = await tool.handler(validatedInput, context, progressCallback);

      const toolDuration = Date.now() - toolStart;
      requestLogger.info(`Tool execution completed: ${name}`);
      Telemetry.capture(TelemetryEvents.TOOL_EXECUTED, { toolName: name, durationMs: toolDuration, success: true });
      // Promote the JSON text payload to structuredContent (back-compat: text stays).
      return withStructuredContent(result);

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

  srv.setRequestHandler(ListToolsRequestSchema as any, async (): Promise<any> => {
    const tools = getTools();
    logger.info('Tools list requested', { toolCount: tools.length });
    return { tools };
  });

  // Resources (epic pglam): browse projects/environments/executions as
  // addressable read URIs. Reads dispatch to the same entity handlers as the
  // tools, so data + auth stay consistent.
  srv.setRequestHandler(ListResourcesRequestSchema as any, async (): Promise<any> => {
    logger.info('Resources list requested', { resourceCount: RESOURCE_COLLECTIONS.length });
    return { resources: RESOURCE_COLLECTIONS };
  });

  srv.setRequestHandler(ListResourceTemplatesRequestSchema as any, async (): Promise<any> => {
    return { resourceTemplates: RESOURCE_TEMPLATES };
  });

  srv.setRequestHandler(ReadResourceRequestSchema as any, async (req: any): Promise<any> => {
    const uri = req.params?.uri as string;
    logger.info('Resource read requested', { uri });
    try {
      return await readResource(uri);
    } catch (error) {
      const mcpError = toMCPError(error, 'resource read');
      logger.error('Resource read failed', { uri, errorCode: mcpError.code, message: mcpError.message });
      throw mcpError;
    }
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

    const transportMode = (process.env.DEBUGGAI_MCP_TRANSPORT || 'stdio').toLowerCase();

    logger.info('Starting DebuggAI MCP Server', {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      pid: process.pid,
      transport: transportMode,
    });

    // stdio is single-user: the API key comes from the environment and is
    // validated at first tool call (bead cma). HTTP is multi-user: each request
    // carries its own bearer token, so a missing env key at boot is expected.
    if (transportMode !== 'http' && !config.api.key) {
      logger.warn(
        'DEBUGGAI_API_KEY is not set. Server will boot but every tool call will return a ConfigurationError until the env var is configured.',
      );
    }

    // Initialize telemetry: PostHog by default (public project key embedded
    // in config so the team can observe cache hit rates, poll cadence, etc.
    // across all installs). Falls back to Noop when DEBUGGAI_TELEMETRY_DISABLED
    // is set. Distinct ID is SHA-256(apiKey) — never the raw key.
    Telemetry.setDistinctId(config.api.key);
    if (config.telemetry.posthogApiKey) {
      const { PostHogProvider } = await import('./services/posthogProvider.js');
      Telemetry.configure(new PostHogProvider(config.telemetry.posthogApiKey, {
        host: config.telemetry.posthogHost,
      }));
      const usingDefault = !process.env.POSTHOG_API_KEY;
      logger.info(
        usingDefault
          ? 'Telemetry enabled (PostHog, DebuggAI default project). Set DEBUGGAI_TELEMETRY_DISABLED=1 to opt out.'
          : 'Telemetry enabled (PostHog, custom POSTHOG_API_KEY)',
      );
    } else {
      logger.info('Telemetry disabled (DEBUGGAI_TELEMETRY_DISABLED is set)');
    }

    // No API calls at boot. Project context is resolved lazily on first tool
    // invocation (list_environments / list_credentials / check_app_in_browser).
    initTools(null);

    if (transportMode === 'http') {
      // Remote/hosted transport (epic lybfq): stateless Streamable HTTP + OAuth
      // Resource Server. stdio stays the default and is unaffected.
      const { startHttpServer } = await import('./httpServer.js');
      const port = Number(process.env.PORT) || 3000;
      await startHttpServer({ port, buildServer: buildConfiguredServer, logger });
      logger.info('DebuggAI MCP Server is running and ready to accept requests', {
        transport: 'http',
        port,
        toolsAvailable: getTools().map(t => t.name),
      });
    } else {
      server = createMCPServer();
      registerHandlers(server);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info('DebuggAI MCP Server is running and ready to accept requests', {
        transport: 'stdio',
        toolsAvailable: getTools().map(t => t.name),
      });
    }

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
