/**
 * Tool registry and exports
 * Centralized location for all DebuggAI MCP tool definitions
 * 
 * These tools provide AI agents with:
 * - Live remote browser sessions for real-time monitoring
 * - End-to-end testing with natural language descriptions  
 * - Browser console logs, network traffic, and screenshot capture
 * - Test suite management and Git commit-based test generation
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ValidatedTool } from '../types/index.js';
import { testPageChangesTool, validatedTestPageChangesTool } from './testPageChanges.js';
import { 
  startLiveSessionTool,
  stopLiveSessionTool,
  getLiveSessionStatusTool,
  getLiveSessionLogsTool,
  getLiveSessionScreenshotTool,
  validatedLiveSessionTools
} from './liveSession.js';
import { 
  listTestsTool,
  listTestSuitesTool,
  createTestSuiteTool, 
  createCommitSuiteTool,
  listCommitSuitesTool,
  getTestStatusTool,
  validatedE2ESuiteTools 
} from './e2eSuites.js';
import { 
  quickScreenshotTool,
  validatedQuickScreenshotTool 
} from './quickScreenshot.js';

/**
 * All available tools for MCP server
 */
export const tools: Tool[] = [
  testPageChangesTool,
  startLiveSessionTool,
  stopLiveSessionTool,
  getLiveSessionStatusTool,
  getLiveSessionLogsTool,
  getLiveSessionScreenshotTool,
  listTestsTool,
  listTestSuitesTool,
  createTestSuiteTool,
  createCommitSuiteTool,
  listCommitSuitesTool,
  getTestStatusTool,
  quickScreenshotTool,
];

/**
 * All validated tools with handlers
 */
export const validatedTools: ValidatedTool[] = [
  validatedTestPageChangesTool,
  ...validatedLiveSessionTools,
  ...validatedE2ESuiteTools,
  validatedQuickScreenshotTool,
];

/**
 * Tool registry for quick lookup
 */
export const toolRegistry = new Map<string, ValidatedTool>();

// Initialize tool registry
for (const tool of validatedTools) {
  toolRegistry.set(tool.name, tool);
}

/**
 * Get tool by name
 */
export function getTool(name: string): ValidatedTool | undefined {
  return toolRegistry.get(name);
}

/**
 * Check if tool exists
 */
export function hasToolTool(name: string): boolean {
  return toolRegistry.has(name);
}