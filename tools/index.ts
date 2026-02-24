import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ValidatedTool } from '../types/index.js';
import { testPageChangesTool, validatedTestPageChangesTool } from './testPageChanges.js';

export const tools: Tool[] = [
  testPageChangesTool,
];

export const validatedTools: ValidatedTool[] = [
  validatedTestPageChangesTool,
];

export const toolRegistry = new Map<string, ValidatedTool>();

for (const tool of validatedTools) {
  toolRegistry.set(tool.name, tool);
}

export function getTool(name: string): ValidatedTool | undefined {
  return toolRegistry.get(name);
}

export function hasToolTool(name: string): boolean {
  return toolRegistry.has(name);
}
