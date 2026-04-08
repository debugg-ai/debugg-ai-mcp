import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ValidatedTool } from '../types/index.js';
import { buildTestPageChangesTool, buildValidatedTestPageChangesTool } from './testPageChanges.js';
import { ProjectContext } from '../services/projectContext.js';

let _tools: Tool[] | null = null;
let _validatedTools: ValidatedTool[] | null = null;
const toolRegistry = new Map<string, ValidatedTool>();

/**
 * Initialize tools with project context (call once after resolveProjectContext).
 */
export function initTools(ctx: ProjectContext | null): void {
  const tool = buildTestPageChangesTool(ctx);
  const validated = buildValidatedTestPageChangesTool(ctx);

  _tools = [tool];
  _validatedTools = [validated];

  toolRegistry.clear();
  toolRegistry.set(validated.name, validated);
}

export function getTools(): Tool[] {
  if (!_tools) initTools(null);
  return _tools!;
}

export function getTool(name: string): ValidatedTool | undefined {
  if (!_validatedTools) initTools(null);
  return toolRegistry.get(name);
}
