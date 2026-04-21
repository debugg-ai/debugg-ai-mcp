import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { GetProjectInputSchema, ValidatedTool } from '../types/index.js';
import { getProjectHandler } from '../handlers/getProjectHandler.js';

const DESCRIPTION = `Fetch a single project by UUID. Returns {project:{uuid,name,slug,platform,repoName,description,status,language,framework,timestamp,lastMod}}. Response is simplified — heavy internal fields (team, runner_configuration, github internals) are omitted. Returns isError:true + NotFound when uuid doesn't exist.`;

export function buildGetProjectTool(): Tool {
  return {
    name: 'get_project',
    title: 'Get Project by UUID',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'UUID of the project. Required.' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedGetProjectTool(): ValidatedTool {
  const tool = buildGetProjectTool();
  return { ...tool, inputSchema: GetProjectInputSchema, handler: getProjectHandler };
}
