import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListCredentialsInputSchema, ValidatedTool } from '../types/index.js';
import { listCredentialsHandler } from '../handlers/listCredentialsHandler.js';

const DESCRIPTION = `List credentials for a DebuggAI project. By default targets the project resolved from the current git repo. Optional environmentId filters to a single environment. Optional q filters by label or username. Optional role filters for exact match (server-side). Optional projectUuid overrides the auto-detected project. Never returns passwords or secret values.`;

export function buildListCredentialsTool(): Tool {
  return {
    name: 'list_credentials',
    title: 'List Project Credentials',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        environmentId: {
          type: 'string',
          description: 'Optional: filter credentials to a single environment UUID.',
        },
        projectUuid: {
          type: 'string',
          description: 'Optional: UUID of the target project. Defaults to the project resolved from the current git repo.',
        },
        q: {
          type: 'string',
          description: 'Optional: filter by label or username (case-insensitive substring).',
        },
        role: {
          type: 'string',
          description: 'Optional: filter by exact role match (e.g. "admin", "guest").',
        },
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
