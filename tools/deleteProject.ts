import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { DeleteProjectInputSchema, ValidatedTool } from '../types/index.js';
import { deleteProjectHandler } from '../handlers/deleteProjectHandler.js';

const DESCRIPTION = `Delete a project by UUID. Returns {deleted:true, uuid}. **DESTRUCTIVE** — removes the project and its associated environments, credentials, and test history. No undo. Returns isError:true + NotFound when already deleted or uuid doesn't exist.`;

export function buildDeleteProjectTool(): Tool {
  return {
    name: 'delete_project',
    title: 'Delete Project',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'UUID of the project to delete. Required.' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedDeleteProjectTool(): ValidatedTool {
  const tool = buildDeleteProjectTool();
  return { ...tool, inputSchema: DeleteProjectInputSchema, handler: deleteProjectHandler };
}
