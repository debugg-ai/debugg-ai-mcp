import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListCredentialsInputSchema, ValidatedTool } from '../types/index.js';
import { listCredentialsHandler } from '../handlers/listCredentialsHandler.js';

const DESCRIPTION = `List credentials for a DebuggAI project. Paginated when scoped to a single environment (pass environmentId); otherwise iterates all envs and returns everything with pageInfo reflecting the total. Default pageSize 20, max 200. Optional q filters label/username (client-side); role filters server-side. Never returns passwords.`;

export function buildListCredentialsTool(): Tool {
  return {
    name: 'list_credentials',
    title: 'List Project Credentials',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        environmentId: { type: 'string', description: 'Optional: filter to a single environment. Required for true pagination.' },
        projectUuid: { type: 'string', description: 'Optional: UUID of the target project. Defaults to git-auto-detect.' },
        q: { type: 'string', description: 'Optional: filter by label or username.' },
        role: { type: 'string', description: 'Optional: filter by exact role match.' },
        page: { type: 'number', description: 'Optional: 1-indexed page number. Default 1.', minimum: 1 },
        pageSize: { type: 'number', description: 'Optional: items per page. Default 20, max 200.', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedListCredentialsTool(): ValidatedTool {
  const tool = buildListCredentialsTool();
  return {
    ...tool,
    inputSchema: ListCredentialsInputSchema,
    handler: listCredentialsHandler,
  };
}
