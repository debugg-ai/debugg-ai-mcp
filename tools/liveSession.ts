/**
 * Live Session Tool Definitions
 * Tools for managing live browser sessions with real-time monitoring
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ValidatedTool } from '../types/index.js';
import { 
  StartLiveSessionInputSchema,
  StopLiveSessionInputSchema,
  GetLiveSessionStatusInputSchema,
  GetLiveSessionLogsInputSchema,
  GetLiveSessionScreenshotInputSchema
} from '../types/index.js';
import { 
  startLiveSessionHandler,
  stopLiveSessionHandler,
  getLiveSessionStatusHandler,
  getLiveSessionLogsHandler,
  getLiveSessionScreenshotHandler
} from '../handlers/liveSessionHandlers.js';

/**
 * Tool definition for starting a live browser session
 */
export const startLiveSessionTool: Tool = {
  name: "debugg_ai_start_live_session",
  description: "Start a live session to monitor browser console output, network traffic, and take screenshots",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to navigate to and monitor",
        minLength: 1
      },
      localPort: {
        type: "number",
        description: "Localhost port number where the app is running (optional if monitoring remote URL)",
        minimum: 1,
        maximum: 65535
      },
      sessionName: {
        type: "string",
        description: "Optional name for the live session",
        maxLength: 100
      },
      monitorConsole: {
        type: "boolean",
        description: "Whether to monitor console output",
        default: true
      },
      monitorNetwork: {
        type: "boolean", 
        description: "Whether to monitor network traffic",
        default: true
      },
      takeScreenshots: {
        type: "boolean",
        description: "Whether to take periodic screenshots",
        default: false
      },
      screenshotInterval: {
        type: "number",
        description: "Screenshot interval in seconds (if takeScreenshots is true)",
        minimum: 1,
        maximum: 300,
        default: 10
      }
    },
    required: ["url"],
    additionalProperties: false
  },
};

/**
 * Tool definition for stopping a live session
 */
export const stopLiveSessionTool: Tool = {
  name: "debugg_ai_stop_live_session", 
  description: "Stop the live session",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "The session ID to stop (optional, will stop current session if not provided)"
      }
    },
    additionalProperties: false
  },
};

/**
 * Tool definition for getting live session status
 */
export const getLiveSessionStatusTool: Tool = {
  name: "debugg_ai_get_live_session_status",
  description: "Get the current status of the live session",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "The session ID to check (optional, will check current session if not provided)"
      }
    },
    additionalProperties: false
  },
};

/**
 * Tool definition for getting live session logs
 */
export const getLiveSessionLogsTool: Tool = {
  name: "debugg_ai_get_live_session_logs",
  description: "Get the logs from the live session",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "The session ID to get logs for (optional, will get current session logs if not provided)"
      },
      logType: {
        type: "string",
        enum: ["console", "network", "errors", "all"],
        description: "Type of logs to retrieve",
        default: "all"
      },
      since: {
        type: "string",
        description: "ISO timestamp to get logs since (optional)",
        format: "date-time"
      },
      limit: {
        type: "number",
        description: "Maximum number of log entries to return",
        minimum: 1,
        maximum: 1000,
        default: 100
      }
    },
    additionalProperties: false
  },
};

/**
 * Tool definition for getting live session screenshot
 */
export const getLiveSessionScreenshotTool: Tool = {
  name: "debugg_ai_get_live_session_screenshot",
  description: "Get the current screenshot from the live session",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "The session ID to get screenshot for (optional, will get current session screenshot if not provided)"
      },
      fullPage: {
        type: "boolean",
        description: "Whether to capture the full page or just the viewport",
        default: false
      },
      quality: {
        type: "number",
        description: "Screenshot quality (1-100 for JPEG, ignored for PNG)",
        minimum: 1,
        maximum: 100,
        default: 90
      },
      format: {
        type: "string",
        enum: ["png", "jpeg"],
        description: "Screenshot format",
        default: "png"
      }
    },
    additionalProperties: false
  },
};

/**
 * Validated tool definitions with handlers
 */
export const validatedStartLiveSessionTool: ValidatedTool = {
  name: "debugg_ai_start_live_session",
  description: startLiveSessionTool.description,
  inputSchema: StartLiveSessionInputSchema,
  handler: startLiveSessionHandler,
};

export const validatedStopLiveSessionTool: ValidatedTool = {
  name: "debugg_ai_stop_live_session",
  description: stopLiveSessionTool.description,
  inputSchema: StopLiveSessionInputSchema,
  handler: stopLiveSessionHandler,
};

export const validatedGetLiveSessionStatusTool: ValidatedTool = {
  name: "debugg_ai_get_live_session_status",
  description: getLiveSessionStatusTool.description,
  inputSchema: GetLiveSessionStatusInputSchema,
  handler: getLiveSessionStatusHandler,
};

export const validatedGetLiveSessionLogsTool: ValidatedTool = {
  name: "debugg_ai_get_live_session_logs",
  description: getLiveSessionLogsTool.description,
  inputSchema: GetLiveSessionLogsInputSchema,
  handler: getLiveSessionLogsHandler,
};

export const validatedGetLiveSessionScreenshotTool: ValidatedTool = {
  name: "debugg_ai_get_live_session_screenshot",
  description: getLiveSessionScreenshotTool.description,
  inputSchema: GetLiveSessionScreenshotInputSchema,
  handler: getLiveSessionScreenshotHandler,
};

export const validatedLiveSessionTools: ValidatedTool[] = [
  validatedStartLiveSessionTool,
  validatedStopLiveSessionTool,
  validatedGetLiveSessionStatusTool,
  validatedGetLiveSessionLogsTool,
  validatedGetLiveSessionScreenshotTool,
];