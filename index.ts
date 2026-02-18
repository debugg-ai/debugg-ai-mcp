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
import { tools, getTool } from "./tools/index.js";
import { 
  Logger, 
  validateInput, 
  createErrorResponse, 
  toMCPError,
  handleConfigurationError
} from "./utils/index.js";
import { 
  TypedCallToolRequest,
  ToolContext,
  ProgressCallback,
  MCPErrorCode 
} from "./types/index.js";

// Initialize logger
const logger = new Logger({ module: 'main' });

/**
 * Initialize MCP Server with configuration
 */
function createMCPServer(): Server {
  logger.info('Initializing DebuggAI MCP Server', { 
    name: config.server.name,
    version: config.server.version 
  });

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

const server = createMCPServer();


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
 * Handle tool execution requests with proper validation and error handling
 */
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

  // Unknown tool is a protocol error - throw directly so SDK returns JSON-RPC error
  const tool = getTool(name);
  if (!tool) {
    requestLogger.warn(`Tool not found: ${name}`);
    throw new Error(`Unknown tool: ${name}`);
  }

  try {
    // Validate input using the tool's schema
    const validatedInput = validateInput(tool.inputSchema, args, name);

    // Create tool context
    const context: ToolContext = {
      progressToken: typeof progressToken === 'string' ? progressToken : undefined,
      requestId,
      timestamp: new Date(),
    };

    // Create progress callback
    const progressCallback = createProgressCallback(typeof progressToken === 'string' || typeof progressToken === 'number' ? String(progressToken) : undefined);

    // Execute tool handler with progress callback
    requestLogger.info(`Executing tool: ${name}`);
    const result = await tool.handler(validatedInput, context, progressCallback);

    requestLogger.info(`Tool execution completed: ${name}`);
    return result;

  } catch (error) {
    // Validation and execution errors are tool execution errors (isError: true)
    // so the model can self-correct
    const mcpError = toMCPError(error, 'tool execution');
    requestLogger.error('Tool execution failed', {
      errorCode: mcpError.code,
      message: mcpError.message,
      data: mcpError.data
    });

    return createErrorResponse(mcpError, typedReq.params.name);
  }
});

/**
 * Handle list tools requests
 */
server.setRequestHandler(ListToolsRequestSchema as any, async (): Promise<any> => {
  logger.info('Tools list requested', { toolCount: tools.length });
  return {
    tools: tools,
  };
});

/**
 * Main server initialization and startup
 */
async function main(): Promise<void> {
  try {
    // Log startup information
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

    // Create and connect transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('DebuggAI MCP Server is running and ready to accept requests', {
      transport: 'stdio',
      toolsAvailable: tools.map(t => t.name)
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
 * Handle graceful shutdown
 */
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

/**
 * Start the server
 */
main().catch((error) => {
  logger.error('Fatal error during startup', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  process.exit(1);
});
