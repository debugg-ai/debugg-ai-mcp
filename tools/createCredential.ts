import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CreateCredentialInputSchema, ValidatedTool } from '../types/index.js';
import { createCredentialHandler } from '../handlers/createCredentialHandler.js';

const DESCRIPTION = `Create a new credential under an environment. Required: environmentId, label, username, password. Optional role (e.g. "admin", "guest"). password is write-only — the response returns only uuid/label/username/role/environmentUuid, never the raw password. Defaults to the project resolved from the current git repo; pass projectUuid to target a different project (get UUIDs via list_projects). Returns the created credential's uuid for use with check_app_in_browser via credentialId.`;

export function buildCreateCredentialTool(): Tool {
  return {
    name: 'create_credential',
    title: 'Create Environment Credential',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        environmentId: {
          type: 'string',
          description: 'UUID of the environment this credential belongs to. Required.',
        },
        label: {
          type: 'string',
          description: 'Human-readable label for the credential (e.g. "Admin Account"). Required.',
          minLength: 1,
        },
        username: {
          type: 'string',
          description: 'Username or email used to log in. Required.',
          minLength: 1,
        },
        password: {
          type: 'string',
          description: 'Password. Write-only — never echoed in any MCP tool response. Required.',
          minLength: 1,
        },
        role: {
          type: 'string',
          description: 'Optional: role string (e.g. "admin", "guest") used by credentialRole resolution.',
        },
        projectUuid: {
          type: 'string',
          description: 'Optional: UUID of the target project. Defaults to the project resolved from the current git repo.',
        },
      },
      required: ['environmentId', 'label', 'username', 'password'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedCreateCredentialTool(): ValidatedTool {
  const tool = buildCreateCredentialTool();
  return {
    ...tool,
    inputSchema: CreateCredentialInputSchema,
    handler: createCredentialHandler,
  };
}
