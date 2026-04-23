import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ValidatedTool } from '../types/index.js';
import { buildTestPageChangesTool, buildValidatedTestPageChangesTool } from './testPageChanges.js';
import { buildTriggerCrawlTool, buildValidatedTriggerCrawlTool } from './triggerCrawl.js';
import { buildSearchProjectsTool, buildValidatedSearchProjectsTool } from './searchProjects.js';
import { buildSearchEnvironmentsTool, buildValidatedSearchEnvironmentsTool } from './searchEnvironments.js';
import { buildSearchExecutionsTool, buildValidatedSearchExecutionsTool } from './searchExecutions.js';
import { buildCreateEnvironmentTool, buildValidatedCreateEnvironmentTool } from './createEnvironment.js';
import { buildUpdateEnvironmentTool, buildValidatedUpdateEnvironmentTool } from './updateEnvironment.js';
import { buildDeleteEnvironmentTool, buildValidatedDeleteEnvironmentTool } from './deleteEnvironment.js';
import { buildUpdateProjectTool, buildValidatedUpdateProjectTool } from './updateProject.js';
import { buildDeleteProjectTool, buildValidatedDeleteProjectTool } from './deleteProject.js';
import { buildCreateProjectTool, buildValidatedCreateProjectTool } from './createProject.js';
import { ProjectContext } from '../services/projectContext.js';

let _tools: Tool[] | null = null;
let _validatedTools: ValidatedTool[] | null = null;
const toolRegistry = new Map<string, ValidatedTool>();

/**
 * Initialize tools with project context (call once after resolveProjectContext).
 */
export function initTools(ctx: ProjectContext | null): void {
  const tools: Tool[] = [
    buildTestPageChangesTool(ctx),
    buildTriggerCrawlTool(ctx),
    buildSearchProjectsTool(),
    buildSearchEnvironmentsTool(),
    buildCreateEnvironmentTool(),
    buildUpdateEnvironmentTool(),
    buildDeleteEnvironmentTool(),
    buildUpdateProjectTool(),
    buildDeleteProjectTool(),
    buildSearchExecutionsTool(),
    buildCreateProjectTool(),
  ];
  const validated: ValidatedTool[] = [
    buildValidatedTestPageChangesTool(ctx),
    buildValidatedTriggerCrawlTool(ctx),
    buildValidatedSearchProjectsTool(),
    buildValidatedSearchEnvironmentsTool(),
    buildValidatedCreateEnvironmentTool(),
    buildValidatedUpdateEnvironmentTool(),
    buildValidatedDeleteEnvironmentTool(),
    buildValidatedUpdateProjectTool(),
    buildValidatedDeleteProjectTool(),
    buildValidatedSearchExecutionsTool(),
    buildValidatedCreateProjectTool(),
  ];

  _tools = tools;
  _validatedTools = validated;

  toolRegistry.clear();
  for (const v of validated) toolRegistry.set(v.name, v);
}

export function getTools(): Tool[] {
  if (!_tools) initTools(null);
  return _tools!;
}

export function getTool(name: string): ValidatedTool | undefined {
  if (!_validatedTools) initTools(null);
  return toolRegistry.get(name);
}
