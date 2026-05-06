import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { UpdateEnvironmentInputSchema, ValidatedTool } from '../types/index.js';
import { updateEnvironmentHandler } from '../handlers/updateEnvironmentHandler.js';

const DESCRIPTION = `Patch an environment by UUID. Updates fields and/or manages credentials in a single call.

ENVIRONMENT FIELDS (all optional — only specified fields change):
- name, url, description

CREDENTIAL MANAGEMENT:
- addCredentials: [{label, username, password, role?}] — add one or more login credentials to this environment
- updateCredentials: [{uuid, label?, username?, password?, role?}] — patch existing credentials by UUID
- removeCredentialIds: ["<uuid>", ...] — delete credentials by UUID

Operations run in order: remove → update → add. All credential ops are best-effort — failures go to credentialWarnings without blocking the rest. Passwords are write-only and NEVER returned in responses.

Returns {updated, environment, addedCredentials?, updatedCredentials?, removedCredentialIds?, credentialWarnings?}. Returns isError:true with NotFound when the env uuid doesn't exist.`;

export function buildUpdateEnvironmentTool(): Tool {
  return {
    name: 'update_environment',
    title: 'Update Environment',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'UUID of the environment to update. Required.' },
        name: { type: 'string', description: 'Optional: new name.', minLength: 1 },
        url: { type: 'string', description: 'Optional: new base URL.' },
        description: { type: 'string', description: 'Optional: new description.' },
        projectUuid: { type: 'string', description: 'Optional: UUID of the target project. Defaults to git-auto-detect.' },
        addCredentials: {
          type: 'array',
          description: 'Add new login credentials to the environment. Each entry requires label, username, password. role is optional.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Human-readable name (e.g. "admin user", "test account").' },
              username: { type: 'string', description: 'Login email or username.' },
              password: { type: 'string', description: 'Password. Write-only — never returned.' },
              role: { type: 'string', description: 'Optional role tag (e.g. "admin", "guest").' },
            },
            required: ['label', 'username', 'password'],
            additionalProperties: false,
          },
        },
        updateCredentials: {
          type: 'array',
          description: 'Patch existing credentials by UUID. Only specified fields change.',
          items: {
            type: 'object',
            properties: {
              uuid: { type: 'string', description: 'UUID of the credential to update.' },
              label: { type: 'string' },
              username: { type: 'string' },
              password: { type: 'string', description: 'Write-only — never returned.' },
              role: { type: 'string' },
            },
            required: ['uuid'],
            additionalProperties: false,
          },
        },
        removeCredentialIds: {
          type: 'array',
          description: 'UUIDs of credentials to delete.',
          items: { type: 'string' },
        },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedUpdateEnvironmentTool(): ValidatedTool {
  const tool = buildUpdateEnvironmentTool();
  return { ...tool, inputSchema: UpdateEnvironmentInputSchema, handler: updateEnvironmentHandler };
}
