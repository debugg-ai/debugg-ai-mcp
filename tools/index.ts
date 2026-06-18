import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ValidatedTool } from '../types/index.js';
import { buildTestPageChangesTool, buildValidatedTestPageChangesTool } from './testPageChanges.js';
import { buildTriggerCrawlTool, buildValidatedTriggerCrawlTool } from './triggerCrawl.js';
import { buildProbePageTool, buildValidatedProbePageTool } from './probePage.js';
import { buildProjectTool, buildValidatedProjectTool } from './project.js';
import { buildEnvironmentTool, buildValidatedEnvironmentTool } from './environment.js';
import { buildExecutionsTool, buildValidatedExecutionsTool } from './executions.js';
import { buildTestSuiteTool, buildValidatedTestSuiteTool } from './testSuite.js';
import { buildTestCaseTool, buildValidatedTestCaseTool } from './testCase.js';
import { ProjectContext } from '../services/projectContext.js';

let _tools: Tool[] | null = null;
let _validatedTools: ValidatedTool[] | null = null;
const toolRegistry = new Map<string, ValidatedTool>();

/**
 * Initialize tools with project context (call once after resolveProjectContext).
 *
 * The surface is 8 action-based tools (epic yg7o6): 3 browser tools plus one
 * tool per managed entity (project/environment/test_suite/test_case/executions),
 * each routing an `action` discriminator to its handler.
 */
export function initTools(ctx: ProjectContext | null): void {
  const tools: Tool[] = [
    buildTestPageChangesTool(ctx),
    buildProbePageTool(),
    buildTriggerCrawlTool(ctx),
    buildProjectTool(),
    buildEnvironmentTool(),
    buildTestSuiteTool(),
    buildTestCaseTool(),
    buildExecutionsTool(),
  ];
  const validated: ValidatedTool[] = [
    buildValidatedTestPageChangesTool(ctx),
    buildValidatedProbePageTool(),
    buildValidatedTriggerCrawlTool(ctx),
    buildValidatedProjectTool(),
    buildValidatedEnvironmentTool(),
    buildValidatedTestSuiteTool(),
    buildValidatedTestCaseTool(),
    buildValidatedExecutionsTool(),
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
