import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListEnvironmentsInputSchema, ValidatedTool } from '../types/index.js';
import { listEnvironmentsHandler } from '../handlers/listEnvironmentsHandler.js';

const DESCRIPTION = `List environments for a DebuggAI project. Paginated — every response includes pageInfo {page, pageSize, totalCount, totalPages, hasMore}; default pageSize 20, max 200. By default targets the project resolved from the current git repo; pass projectUuid to target a different project. Optional q filters by environment name via backend search.`;

export function buildListEnvironmentsTool(): Tool {
  return {
    name: 'list_environments',
    title: 'List Project Environments',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        projectUuid: { type: 'string', description: 'Optional: UUID of the project to query. Defaults to git-auto-detect.' },
        q: { type: 'string', description: 'Optional: filter by environment name.' },
        page: { type: 'number', description: 'Optional: 1-indexed page number. Default 1.', minimum: 1 },
        pageSize: { type: 'number', description: 'Optional: items per page. Default 20, max 200.', minimum: 1, maximum: 200 },
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
