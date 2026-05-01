import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SearchEnvironmentsInputSchema, ValidatedTool } from '../types/index.js';
import { searchEnvironmentsHandler } from '../handlers/searchEnvironmentsHandler.js';

const DESCRIPTION = `Search or look up environments, with credentials expanded inline per environment.

Two modes:
  - uuid mode: {"uuid": "<env-uuid>"} → single env with full detail + its credentials. NotFound if the uuid doesn't exist.
  - filter mode: omit uuid, optionally {"q": "<keyword>", "projectUuid", "page", "pageSize"} → paginated envs, each with its credentials.

Project resolution: if projectUuid is omitted, the current git repo's origin is auto-resolved to a DebuggAI project. Returns {error:"NoProjectResolved", environments:[]} if neither is available.

Credentials are returned inline per env as {uuid, label, username, role}. Password is NEVER returned — the handler defensively strips it regardless of what the service layer provides.

Response: {project, filter, pageInfo, environments[]} — each environment includes a credentials[] array.`;

export function buildSearchEnvironmentsTool(): Tool {
  return {
    name: 'search_environments',
    title: 'Search Environments',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Environment UUID. Returns single env with credentials inline. Mutually exclusive with projectUuid/q filter params.' },
        projectUuid: { type: 'string', description: 'Override the auto-detected project. Used in filter mode.' },
        q: { type: 'string', description: 'Free-text search over environment name. Mutually exclusive with uuid.' },
        page: { type: 'number', description: 'Page number (1-indexed).' },
        pageSize: { type: 'number', description: 'Page size (1..200). Default 20.' },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedSearchEnvironmentsTool(): ValidatedTool {
  const tool = buildSearchEnvironmentsTool();
  return { ...tool, inputSchema: SearchEnvironmentsInputSchema, handler: searchEnvironmentsHandler };
}
