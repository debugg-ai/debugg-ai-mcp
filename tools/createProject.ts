import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CreateProjectInputSchema, ValidatedTool } from '../types/index.js';
import { createProjectHandler } from '../handlers/createProjectHandler.js';

const DESCRIPTION = `Create a new DebuggAI project. Required: name, platform (e.g. "web"), teamUuid (from list_teams), repoUuid (from list_repos). Returns {created: true, project: {uuid, name, slug, platform, repoName, ...}}. The repo must be GitHub-linked to the account. Use list_teams + list_repos first to discover valid UUIDs.`;

export function buildCreateProjectTool(): Tool {
  return {
    name: 'create_project',
    title: 'Create Project',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name. Required.', minLength: 1 },
        platform: { type: 'string', description: 'Platform (e.g. "web"). Required.', minLength: 1 },
        teamUuid: { type: 'string', description: 'Team UUID (from list_teams). Required.' },
        repoUuid: { type: 'string', description: 'GitHub repo UUID (from list_repos). Required — repo must be GitHub-linked.' },
      },
      required: ['name', 'platform', 'teamUuid', 'repoUuid'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedCreateProjectTool(): ValidatedTool {
  const tool = buildCreateProjectTool();
  return { ...tool, inputSchema: CreateProjectInputSchema, handler: createProjectHandler };
}
