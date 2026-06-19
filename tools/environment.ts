import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { EnvironmentInputSchema, ValidatedTool } from '../types/index.js';
import { environmentHandler } from '../handlers/environmentHandler.js';

const CRED_ITEM = {
  type: 'object',
  properties: {
    label: { type: 'string' }, username: { type: 'string' }, password: { type: 'string', description: 'Write-only — never returned.' }, role: { type: 'string' },
  },
  required: ['label', 'username', 'password'],
  additionalProperties: false,
};

const DESCRIPTION = `Manage environments (and their login credentials) under a project. Pass an "action":
  - "get"    {uuid, projectUuid?} → one environment with credentials inline (passwords never returned).
  - "list"   {projectUuid?, q?, page?, pageSize?} → paginated environments. projectUuid auto-resolves from the git repo if omitted.
  - "create" {name, url, description?, projectUuid?, credentials?} → create an env, optionally seeding credentials.
  - "update" {uuid, name?, url?, description?, addCredentials?, updateCredentials?, removeCredentialIds?} → patch env + manage credentials.
  - "delete" {uuid, projectUuid?, confirm?} → delete env (DESTRUCTIVE; requires confirmation).`;

export function buildEnvironmentTool(): Tool {
  return {
    name: 'environment',
    title: 'Environment',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'list', 'create', 'update', 'delete'], description: 'Operation to perform.' },
        uuid: { type: 'string', description: '[get/update/delete] Environment UUID.' },
        projectUuid: { type: 'string', description: 'Target project (defaults to git auto-detect).' },
        q: { type: 'string', description: '[list] Free-text search over env name.' },
        page: { type: 'number', description: '[list] Page (1-indexed).' },
        pageSize: { type: 'number', description: '[list] Page size (1..200).' },
        name: { type: 'string', description: '[create/update] Environment name.' },
        url: { type: 'string', description: '[create/update] Base URL.' },
        description: { type: 'string', description: '[create/update] Free-text description.' },
        credentials: { type: 'array', items: CRED_ITEM, description: '[create] Seed login credentials.' },
        addCredentials: { type: 'array', items: CRED_ITEM, description: '[update] Add credentials.' },
        updateCredentials: { type: 'array', items: { type: 'object', properties: { uuid: { type: 'string' }, label: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' }, role: { type: 'string' } }, required: ['uuid'], additionalProperties: false }, description: '[update] Patch credentials by UUID.' },
        removeCredentialIds: { type: 'array', items: { type: 'string' }, description: '[update] Delete credentials by UUID.' },
        confirm: { type: 'boolean', description: '[delete] Set true to confirm deletion (when the client cannot prompt).' },
      },
      required: ['action'],
      // No top-level oneOf/anyOf/allOf: the Anthropic tool input_schema rejects
      // them and clients (Claude Code) silently drop the tool. Per-action required
      // fields are enforced by the Zod discriminated union in types/index.ts and
      // documented in DESCRIPTION above.
      additionalProperties: false,
    },
  };
}

export function buildValidatedEnvironmentTool(): ValidatedTool {
  return { ...buildEnvironmentTool(), inputSchema: EnvironmentInputSchema, handler: environmentHandler };
}
