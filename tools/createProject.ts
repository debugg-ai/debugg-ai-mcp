import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CreateProjectInputSchema, ValidatedTool } from '../types/index.js';
import { createProjectHandler } from '../handlers/createProjectHandler.js';

const DESCRIPTION = `Create a new DebuggAI project. Required: name, platform (e.g. "web"), plus a team and a repo. Team and repo each accept EITHER a UUID or a name: pass teamUuid OR teamName, and repoUuid OR repoName. Name resolution does a backend search with case-insensitive exact match (returns AmbiguousMatch with candidates on multiple hits, NotFound on no hit). The repo must be GitHub-linked to the account. Returns {created: true, project: {uuid, name, slug, platform, repoName, ...}}.`;

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
        teamUuid: { type: 'string', description: 'Team UUID. Provide teamUuid OR teamName, not both.' },
        teamName: { type: 'string', description: 'Team name (backend-resolved, case-insensitive exact match). Provide teamUuid OR teamName, not both.' },
        repoUuid: { type: 'string', description: 'GitHub repo UUID. Provide repoUuid OR repoName, not both. Repo must be GitHub-linked.' },
        repoName: { type: 'string', description: 'GitHub repo name, e.g. "org/repo" (backend-resolved, case-insensitive exact match). Provide repoUuid OR repoName, not both.' },
      },
      required: ['name', 'platform'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedCreateProjectTool(): ValidatedTool {
  const tool = buildCreateProjectTool();
  return { ...tool, inputSchema: CreateProjectInputSchema, handler: createProjectHandler };
}
