import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CreateEnvironmentInputSchema, ValidatedTool } from '../types/index.js';
import { createEnvironmentHandler } from '../handlers/createEnvironmentHandler.js';

const DESCRIPTION = `Create a new environment under a DebuggAI project. Both name and url are required (backend rejects standard environments without a URL). Optional description. Defaults to the project resolved from the current git repo; pass projectUuid to target a different project (get UUIDs via list_projects). Returns the created environment's uuid so you can reference it when running check_app_in_browser or creating credentials.`;

export function buildCreateEnvironmentTool(): Tool {
  return {
    name: 'create_environment',
    title: 'Create Project Environment',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short label for the environment (e.g. "staging", "production"). Required.',
          minLength: 1,
        },
        url: {
          type: 'string',
          description: 'Base URL for the environment (e.g. https://staging.example.com). Required.',
        },
        description: {
          type: 'string',
          description: 'Optional: free-text description.',
        },
        projectUuid: {
          type: 'string',
          description: 'Optional: UUID of the target project. Defaults to the project resolved from the current git repo.',
        },
      },
      required: ['name', 'url'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedCreateEnvironmentTool(): ValidatedTool {
  const tool = buildCreateEnvironmentTool();
  return {
    ...tool,
    inputSchema: CreateEnvironmentInputSchema,
    handler: createEnvironmentHandler,
  };
}
