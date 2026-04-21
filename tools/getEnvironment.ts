import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { GetEnvironmentInputSchema, ValidatedTool } from '../types/index.js';
import { getEnvironmentHandler } from '../handlers/getEnvironmentHandler.js';

const DESCRIPTION = `Fetch a single environment by UUID. Returns full detail (uuid, name, url, isActive, description, endpointType, activeUrl, timestamp, lastMod). Defaults to the project resolved from the current git repo; pass projectUuid to target a different project. Returns isError:true with NotFound when the uuid doesn't exist.`;

export function buildGetEnvironmentTool(): Tool {
  return {
    name: 'get_environment',
    title: 'Get Environment by UUID',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'UUID of the environment to fetch. Required.' },
        projectUuid: { type: 'string', description: 'Optional: UUID of the target project. Defaults to git-auto-detect.' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedGetEnvironmentTool(): ValidatedTool {
  const tool = buildGetEnvironmentTool();
  return { ...tool, inputSchema: GetEnvironmentInputSchema, handler: getEnvironmentHandler };
}
