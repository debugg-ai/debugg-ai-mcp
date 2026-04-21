import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { DeleteEnvironmentInputSchema, ValidatedTool } from '../types/index.js';
import { deleteEnvironmentHandler } from '../handlers/deleteEnvironmentHandler.js';

const DESCRIPTION = `Delete an environment by UUID. Returns {deleted: true, uuid}. Destructive — cascades per backend behavior (credentials under the env are typically removed). Defaults to the project resolved from the current git repo; pass projectUuid to target a different project. Returns isError:true with NotFound when the uuid doesn't exist or was already deleted.`;

export function buildDeleteEnvironmentTool(): Tool {
  return {
    name: 'delete_environment',
    title: 'Delete Environment',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'UUID of the environment to delete. Required.' },
        projectUuid: { type: 'string', description: 'Optional: UUID of the target project. Defaults to git-auto-detect.' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedDeleteEnvironmentTool(): ValidatedTool {
  const tool = buildDeleteEnvironmentTool();
  return { ...tool, inputSchema: DeleteEnvironmentInputSchema, handler: deleteEnvironmentHandler };
}
