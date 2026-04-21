import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ValidatedTool } from '../types/index.js';
import { buildTestPageChangesTool, buildValidatedTestPageChangesTool } from './testPageChanges.js';
import { buildListEnvironmentsTool, buildValidatedListEnvironmentsTool } from './listEnvironments.js';
import { buildListCredentialsTool, buildValidatedListCredentialsTool } from './listCredentials.js';
import { buildListProjectsTool, buildValidatedListProjectsTool } from './listProjects.js';
import { buildCreateEnvironmentTool, buildValidatedCreateEnvironmentTool } from './createEnvironment.js';
import { buildCreateCredentialTool, buildValidatedCreateCredentialTool } from './createCredential.js';
import { buildGetEnvironmentTool, buildValidatedGetEnvironmentTool } from './getEnvironment.js';
import { buildUpdateEnvironmentTool, buildValidatedUpdateEnvironmentTool } from './updateEnvironment.js';
import { buildDeleteEnvironmentTool, buildValidatedDeleteEnvironmentTool } from './deleteEnvironment.js';
import { buildGetCredentialTool, buildValidatedGetCredentialTool } from './getCredential.js';
import { buildUpdateCredentialTool, buildValidatedUpdateCredentialTool } from './updateCredential.js';
import { buildDeleteCredentialTool, buildValidatedDeleteCredentialTool } from './deleteCredential.js';
import { buildGetProjectTool, buildValidatedGetProjectTool } from './getProject.js';
import { buildUpdateProjectTool, buildValidatedUpdateProjectTool } from './updateProject.js';
import { buildDeleteProjectTool, buildValidatedDeleteProjectTool } from './deleteProject.js';
import { buildListExecutionsTool, buildValidatedListExecutionsTool } from './listExecutions.js';
import { buildGetExecutionTool, buildValidatedGetExecutionTool } from './getExecution.js';
import { buildCancelExecutionTool, buildValidatedCancelExecutionTool } from './cancelExecution.js';
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
    buildListProjectsTool(),
    buildListEnvironmentsTool(),
    buildListCredentialsTool(),
    buildCreateEnvironmentTool(),
    buildCreateCredentialTool(),
    buildGetEnvironmentTool(),
    buildUpdateEnvironmentTool(),
    buildDeleteEnvironmentTool(),
    buildGetCredentialTool(),
    buildUpdateCredentialTool(),
    buildDeleteCredentialTool(),
    buildGetProjectTool(),
    buildUpdateProjectTool(),
    buildDeleteProjectTool(),
    buildListExecutionsTool(),
    buildGetExecutionTool(),
    buildCancelExecutionTool(),
  ];
  const validated: ValidatedTool[] = [
    buildValidatedTestPageChangesTool(ctx),
    buildValidatedListProjectsTool(),
    buildValidatedListEnvironmentsTool(),
    buildValidatedListCredentialsTool(),
    buildValidatedCreateEnvironmentTool(),
    buildValidatedCreateCredentialTool(),
    buildValidatedGetEnvironmentTool(),
    buildValidatedUpdateEnvironmentTool(),
    buildValidatedDeleteEnvironmentTool(),
    buildValidatedGetCredentialTool(),
    buildValidatedUpdateCredentialTool(),
    buildValidatedDeleteCredentialTool(),
    buildValidatedGetProjectTool(),
    buildValidatedUpdateProjectTool(),
    buildValidatedDeleteProjectTool(),
    buildValidatedListExecutionsTool(),
    buildValidatedGetExecutionTool(),
    buildValidatedCancelExecutionTool(),
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
