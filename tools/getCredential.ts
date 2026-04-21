import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { GetCredentialInputSchema, ValidatedTool } from '../types/index.js';
import { getCredentialHandler } from '../handlers/getCredentialHandler.js';

const DESCRIPTION = `Fetch a single credential by UUID. Returns {credential:{uuid,label,username,role,environmentUuid,environmentName,isActive,isDefault,description,timestamp,lastMod}}. Never returns the password. Requires environmentId. Returns isError:true + NotFound when the uuid doesn't exist.`;

export function buildGetCredentialTool(): Tool {
  return {
    name: 'get_credential',
    title: 'Get Credential by UUID',
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

export function buildValidatedGetCredentialTool(): ValidatedTool {
  const tool = buildGetCredentialTool();
  return { ...tool, inputSchema: GetCredentialInputSchema, handler: getCredentialHandler };
}
