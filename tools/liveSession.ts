/**
 * Live Session Tool Definitions
 * Tools for launching and managing live remote web browser sessions
 * 
 * "Live session" = A real browser running on remote servers that you can monitor
 * "Session logs" = Console.log(), console.error(), and network requests from the remote browser
 * 
 * These tools let you:
 * - Start a remote browser pointing to your localhost or any URL
 * - Monitor JavaScript console output in real-time  
 * - Track HTTP requests and responses made by the browser
 * - Capture screenshots of what users would see
 * - Stop sessions and review all captured data
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
  description: "Launch a live remote web browser session to monitor your application in real-time. Captures browser console logs, network requests, and screenshots while your app runs.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL of your application to monitor (e.g., http://localhost:3000 or https://myapp.com)",
        minLength: 1
      },
      localPort: {
        type: "number",
        description: "Port number for localhost apps (e.g., 3000, 8080) - only needed for local development servers",
        minimum: 1,
        maximum: 65535
      },
      sessionName: {
        type: "string",
        description: "Human-readable name for this monitoring session (e.g., 'Dashboard Testing')",
        maxLength: 100
      },
      monitorConsole: {
        type: "boolean",
        description: "Capture JavaScript console.log(), console.error(), and other console output from the remote browser",
        default: true
      },
      monitorNetwork: {
        type: "boolean", 
        description: "Track all HTTP requests and responses made by the remote browser (API calls, asset loading, etc.)",
        default: true
      },
      takeScreenshots: {
        type: "boolean",
        description: "Automatically capture screenshots of the remote browser at regular intervals",
        default: false
      },
      screenshotInterval: {
        type: "number",
        description: "How often to capture screenshots in seconds (only when takeScreenshots is enabled)",
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
  description: "Stop a running remote browser session and cleanup all monitoring. Browser closes and all captured data is saved.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Specific session ID to stop. Leave empty to stop the most recent active session."
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
  description: "Check if the remote browser session is running, what URL it's on, how long it's been active, and monitoring statistics.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Specific session ID to check status for. Leave empty to check the most recent session."
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
  description: "Retrieve browser console logs, network request logs, and JavaScript errors captured from the remote browser during the live session. These are the actual console.log(), console.error(), API calls, and error messages that occurred while your app was running.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Specific session ID to get logs from. Leave empty to get logs from the most recent session."
      },
      logType: {
        type: "string",
        enum: ["console", "network", "errors", "all"],
        description: "Filter log types: 'console' for console.log/error messages, 'network' for HTTP requests/responses, 'errors' for JavaScript errors, 'all' for everything",
        default: "all"
      },
      since: {
        type: "string",
        description: "Only return logs after this timestamp (ISO format like '2024-01-01T12:00:00Z')",
        format: "date-time"
      },
      limit: {
        type: "number",
        description: "Maximum number of log entries to return (most recent first)",
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
  description: "Capture a screenshot of what the remote browser currently displays. Shows exactly what users would see on their screen at this moment.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Specific session ID to capture screenshot from. Leave empty to screenshot the most recent session."
      },
      fullPage: {
        type: "boolean",
        description: "Capture entire webpage (including parts below the fold) vs. just visible area in browser viewport",
        default: false
      },
      quality: {
        type: "number",
        description: "Image quality from 1-100 (only affects JPEG format, higher = better quality but larger file)",
        minimum: 1,
        maximum: 100,
        default: 90
      },
      format: {
        type: "string",
        enum: ["png", "jpeg"],
        description: "Image format: 'png' for lossless quality, 'jpeg' for smaller file size",
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