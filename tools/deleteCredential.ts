import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { DeleteCredentialInputSchema, ValidatedTool } from '../types/index.js';
import { deleteCredentialHandler } from '../handlers/deleteCredentialHandler.js';

const DESCRIPTION = `Delete a credential by UUID. Returns {deleted:true, uuid}. Requires environmentId. Destructive — the credential is gone. Returns isError:true + NotFound when already deleted or uuid doesn't exist.`;

export function buildDeleteCredentialTool(): Tool {
  return {
    name: 'delete_credential',
    title: 'Delete Credential',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'UUID of the credential. Required.' },
        environmentId: { type: 'string', description: 'UUID of the environment the cred belongs to. Required.' },
        projectUuid: { type: 'string', description: 'Optional: project UUID. Defaults to git-auto-detect.' },
      },
      required: ['uuid', 'environmentId'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedDeleteCredentialTool(): ValidatedTool {
  const tool = buildDeleteCredentialTool();
  return { ...tool, inputSchema: DeleteCredentialInputSchema, handler: deleteCredentialHandler };
}
