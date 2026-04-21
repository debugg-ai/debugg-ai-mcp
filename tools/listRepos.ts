import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListReposInputSchema, ValidatedTool } from '../types/index.js';
import { listReposHandler } from '../handlers/listReposHandler.js';

const DESCRIPTION = `List GitHub repos linked to the current account. Paginated — every response includes pageInfo {page, pageSize, totalCount, totalPages, hasMore}; default pageSize 20, max 200. Optional q filters by repo name via backend search. Use this to discover repoUuid values required by create_project. Prefer repos with isGithubAuthorized:true since the backend needs a valid GitHub installation.`;

export function buildListReposTool(): Tool {
  return {
    name: 'list_repos',
    title: 'List Linked Repos',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Optional: filter by repo name.' },
        page: { type: 'number', description: 'Optional: 1-indexed page number.', minimum: 1 },
        pageSize: { type: 'number', description: 'Optional: items per page. Default 20, max 200.', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedListReposTool(): ValidatedTool {
  const tool = buildListReposTool();
  return { ...tool, inputSchema: ListReposInputSchema, handler: listReposHandler };
}
