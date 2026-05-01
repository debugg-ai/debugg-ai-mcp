import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SearchProjectsInputSchema, ValidatedTool } from '../types/index.js';
import { searchProjectsHandler } from '../handlers/searchProjectsHandler.js';

const DESCRIPTION = `Search or look up projects.

Two modes:
  - uuid mode: pass {"uuid": "<project-uuid>"} → returns that project with the curated detail view (uuid, name, slug, platform, repoName, description, status, language, framework, timestamp, lastMod), or isError:true NotFound.
  - filter mode: omit uuid, optionally pass {"q": "<keyword>", "page": 1, "pageSize": 20} → returns a paginated list of summaries (uuid, name, slug, repoName).

Response shape is always {filter, pageInfo, projects[]}. uuid mode returns exactly one project; filter mode returns summaries.`;

export function buildSearchProjectsTool(): Tool {
  return {
    name: 'search_projects',
    title: 'Search Projects',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Project UUID. When provided, returns exactly that project with full detail. Mutually exclusive with q.' },
        q: { type: 'string', description: 'Free-text search (backend-side). Mutually exclusive with uuid.' },
        page: { type: 'number', description: 'Page number (1-indexed). Default 1.' },
        pageSize: { type: 'number', description: 'Page size (1..200). Default 20.' },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedSearchProjectsTool(): ValidatedTool {
  const tool = buildSearchProjectsTool();
  return { ...tool, inputSchema: SearchProjectsInputSchema, handler: searchProjectsHandler };
}
