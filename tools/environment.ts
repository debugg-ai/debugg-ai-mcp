import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { EnvironmentInputSchema, ValidatedTool } from '../types/index.js';
import { environmentHandler } from '../handlers/environmentHandler.js';
import { DESTRUCTIVE } from './annotations.js';

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
  - "delete" {uuid, projectUuid?, confirm?} → delete env (DESTRUCTIVE; requires confirmation).
  - "sessions" {uuid, username?, credentialId?} → captured login sessions this env is holding, and whether each would be reused.
  - "clearSessions" {uuid, username?, credentialId?, confirm?} → invalidate them so the next run logs in for real.

SESSIONS: runs reuse a warm authenticated session per account instead of logging in every time. That is why a check can report "no login form" — it was already signed in. Use "sessions" to see whose session is held, "clearSessions" to drop it, or pass freshSession:true on a single check_app_in_browser call to bypass reuse without clearing anything.`;

export function buildEnvironmentTool(): Tool {
  return {
    name: 'environment',
    title: 'Environment',
    annotations: DESTRUCTIVE,
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'list', 'create', 'update', 'delete', 'sessions', 'clearSessions'], description: 'Operation to perform.' },
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
        username: { type: 'string', description: '[sessions/clearSessions] Narrow to one account. Matched case-insensitively.' },
        credentialId: { type: 'string', description: '[sessions/clearSessions] Narrow to one stored credential by UUID.' },
        confirm: { type: 'boolean', description: '[delete/clearSessions] Set true to confirm (when the client cannot prompt). clearSessions only needs it when no username/credentialId narrows it.' },
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
