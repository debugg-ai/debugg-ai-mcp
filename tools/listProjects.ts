import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListProjectsInputSchema, ValidatedTool } from '../types/index.js';
import { listProjectsHandler } from '../handlers/listProjectsHandler.js';

const DESCRIPTION = `List DebuggAI projects accessible to the current API key. Optional "q" input filters by project name or repo name (passed through to the backend search). Returns uuid, name, slug, and repo for each project. Use this when you don't know which project to target or when the current git repo doesn't resolve to a DebuggAI project.`;

export function buildListProjectsTool(): Tool {
  return {
    name: 'list_projects',
    title: 'List DebuggAI Projects',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: 'Optional search query to filter projects by name or repo name.',
        },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedListProjectsTool(): ValidatedTool {
  const tool = buildListProjectsTool();
  return {
    ...tool,
    inputSchema: ListProjectsInputSchema,
    handler: listProjectsHandler,
  };
}
