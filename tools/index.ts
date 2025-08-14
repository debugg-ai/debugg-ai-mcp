/**
 * Tool registry and exports
 * Centralized location for all tool definitions
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
];

/**
 * All validated tools with handlers
 */
export const validatedTools: ValidatedTool[] = [
  validatedTestPageChangesTool,
  ...validatedLiveSessionTools,
  ...validatedE2ESuiteTools,
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