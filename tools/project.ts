import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ProjectInputSchema, ValidatedTool } from '../types/index.js';
import { projectHandler } from '../handlers/projectHandler.js';

const DESCRIPTION = `Manage DebuggAI projects. Pass an "action":
  - "get"    {uuid} → one project with full detail.
  - "list"   {q?, page?, pageSize?} → paginated project summaries.
  - "create" {name, platform, (teamUuid|teamName), (repoUuid|repoName)} → create a project. The repo must be GitHub-linked; names resolve by case-insensitive exact match.

Note: there is no update/delete here — rename/delete a project from the DebuggAI web app.`;

export function buildProjectTool(): Tool {
  return {
    name: 'project',
    title: 'Project',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'list', 'create'], description: 'Operation to perform.' },
        uuid: { type: 'string', description: '[get] Project UUID.' },
        q: { type: 'string', description: '[list] Free-text search.' },
        page: { type: 'number', description: '[list] Page (1-indexed).' },
        pageSize: { type: 'number', description: '[list] Page size (1..200).' },
        name: { type: 'string', description: '[create] Project name.' },
        platform: { type: 'string', description: '[create] Platform, e.g. "web".' },
        teamUuid: { type: 'string', description: '[create] Team UUID (or teamName).' },
        teamName: { type: 'string', description: '[create] Team name (or teamUuid).' },
        repoUuid: { type: 'string', description: '[create] GitHub repo UUID (or repoName).' },
        repoName: { type: 'string', description: '[create] GitHub repo name "org/repo" (or repoUuid).' },
      },
      required: ['action'],
      oneOf: [
        { properties: { action: { const: 'get' } }, required: ['action', 'uuid'] },
        { properties: { action: { const: 'list' } }, required: ['action'] },
        { properties: { action: { const: 'create' } }, required: ['action', 'name', 'platform'] },
      ],
      additionalProperties: false,
    },
  };
}

export function buildValidatedProjectTool(): ValidatedTool {
  return { ...buildProjectTool(), inputSchema: ProjectInputSchema, handler: projectHandler };
}
