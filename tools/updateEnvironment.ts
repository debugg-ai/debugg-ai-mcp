import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { UpdateEnvironmentInputSchema, ValidatedTool } from '../types/index.js';
import { updateEnvironmentHandler } from '../handlers/updateEnvironmentHandler.js';

const DESCRIPTION = `Patch an environment by UUID. Only specified fields (name, url, description) change — other fields are left intact. Returns {updated: true, environment: {...}} with the updated resource. Defaults to the project resolved from the current git repo; pass projectUuid to target a different project. Returns isError:true with NotFound when the uuid doesn't exist.`;

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
