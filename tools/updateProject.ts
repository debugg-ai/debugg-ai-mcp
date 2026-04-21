import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { UpdateProjectInputSchema, ValidatedTool } from '../types/index.js';
import { updateProjectHandler } from '../handlers/updateProjectHandler.js';

const DESCRIPTION = `Patch a project by UUID. Optional fields: name, description. Returns {updated:true, project:{...simplified resource}}. Returns isError:true + NotFound when uuid doesn't exist.`;

export function buildUpdateProjectTool(): Tool {
  return {
    name: 'update_project',
    title: 'Update Project',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'UUID of the project. Required.' },
        name: { type: 'string', description: 'Optional: new name.', minLength: 1 },
        description: { type: 'string', description: 'Optional: new description.' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedUpdateProjectTool(): ValidatedTool {
  const tool = buildUpdateProjectTool();
  return { ...tool, inputSchema: UpdateProjectInputSchema, handler: updateProjectHandler };
}
