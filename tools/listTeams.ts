import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListTeamsInputSchema, ValidatedTool } from '../types/index.js';
import { listTeamsHandler } from '../handlers/listTeamsHandler.js';

const DESCRIPTION = `List teams accessible to the current API key. Paginated — every response includes pageInfo {page, pageSize, totalCount, totalPages, hasMore}; default pageSize 20, max 200. Optional q filters by team name via backend search. Use this to discover teamUuid values required by create_project.`;

export function buildListTeamsTool(): Tool {
  return {
    name: 'list_teams',
    title: 'List Teams',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Optional: filter by team name.' },
        page: { type: 'number', description: 'Optional: 1-indexed page number.', minimum: 1 },
        pageSize: { type: 'number', description: 'Optional: items per page. Default 20, max 200.', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedListTeamsTool(): ValidatedTool {
  const tool = buildListTeamsTool();
  return { ...tool, inputSchema: ListTeamsInputSchema, handler: listTeamsHandler };
}
