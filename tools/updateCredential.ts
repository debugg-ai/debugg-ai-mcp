import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { UpdateCredentialInputSchema, ValidatedTool } from '../types/index.js';
import { updateCredentialHandler } from '../handlers/updateCredentialHandler.js';

const DESCRIPTION = `Patch a credential by UUID. Optional fields: label, username, password, role. Password is write-only — set it to rotate, but it is never returned in any response. Requires environmentId. Returns {updated:true, credential:{...}}.`;

export function buildUpdateCredentialTool(): Tool {
  return {
    name: 'update_credential',
    title: 'Update Credential',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'UUID of the credential. Required.' },
        environmentId: { type: 'string', description: 'UUID of the environment the cred belongs to. Required.' },
        label: { type: 'string', description: 'Optional: new label.', minLength: 1 },
        username: { type: 'string', description: 'Optional: new username.', minLength: 1 },
        password: { type: 'string', description: 'Optional: new password (write-only — never echoed).', minLength: 1 },
        role: { type: 'string', description: 'Optional: new role (note: backend currently drops role, see bead hpo).', minLength: 1 },
        projectUuid: { type: 'string', description: 'Optional: project UUID. Defaults to git-auto-detect.' },
      },
      required: ['uuid', 'environmentId'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedUpdateCredentialTool(): ValidatedTool {
  const tool = buildUpdateCredentialTool();
  return { ...tool, inputSchema: UpdateCredentialInputSchema, handler: updateCredentialHandler };
}
