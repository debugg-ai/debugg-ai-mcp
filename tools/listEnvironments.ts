import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListEnvironmentsInputSchema, ValidatedTool } from '../types/index.js';
import { listEnvironmentsHandler } from '../handlers/listEnvironmentsHandler.js';

const DESCRIPTION = `List environments for a DebuggAI project. By default targets the project resolved from the current git repo; pass projectUuid to target a different project (get UUIDs via list_projects). Optional q filters by environment name via the backend search. Returns each environment's uuid, name, url, and isActive flag.`;

export function buildListEnvironmentsTool(): Tool {
  return {
    name: 'list_environments',
    title: 'List Project Environments',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        projectUuid: {
          type: 'string',
          description: 'Optional: UUID of the project to query. Defaults to the project resolved from the current git repo.',
        },
        q: {
          type: 'string',
          description: 'Optional: filter environments by name (server-side search).',
        },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedListEnvironmentsTool(): ValidatedTool {
  const tool = buildListEnvironmentsTool();
  return {
    ...tool,
    inputSchema: ListEnvironmentsInputSchema,
    handler: listEnvironmentsHandler,
  };
}
