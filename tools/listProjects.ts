import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListProjectsInputSchema, ValidatedTool } from '../types/index.js';
import { listProjectsHandler } from '../handlers/listProjectsHandler.js';

const DESCRIPTION = `List DebuggAI projects accessible to the current API key. Paginated — every response includes pageInfo {page, pageSize, totalCount, totalPages, hasMore}; default pageSize 20, max 200. Optional "q" input filters by project name or repo name via backend search. Use this when you don't know which project to target or when the current git repo doesn't resolve to a DebuggAI project.`;

export function buildListProjectsTool(): Tool {
  return {
    name: 'list_projects',
    title: 'List DebuggAI Projects',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Optional: search by name or repo name.' },
        page: { type: 'number', description: 'Optional: 1-indexed page number. Default 1.', minimum: 1 },
        pageSize: { type: 'number', description: 'Optional: items per page. Default 20, max 200.', minimum: 1, maximum: 200 },
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
