/**
 * Test Page Changes Tool Definition
 * Defines the check_app_in_browser tool with proper validation.
 * Tool description is enriched at startup with available environments/credentials.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TestPageChangesInputSchema, ValidatedTool } from '../types/index.js';
import { testPageChangesHandler } from '../handlers/testPageChangesHandler.js';
import { ProjectContext } from '../services/projectContext.js';
import { WRITES } from './annotations.js';

const BASE_DESCRIPTION = `Give an AI agent eyes on a live website or app. The agent browses it, interacts with it, and tells you whether a given task or check passed. Works on localhost or any URL. Use for visual QA, flow validation, regression checks, or anything that needs a real browser to verify.

LOCALHOST SUPPORT: Pass any localhost URL (e.g. http://localhost:3000) and it Just Works. A secure tunnel is automatically created so the remote browser can reach your local dev server — no manual ngrok setup, no port forwarding, no config.

SCOPE PER CALL: Keep each call to ONE focused check — a single page or a short interaction on a single screen (login, submit a form, verify a heading). For anything spanning multiple pages or long multi-step flows, split into SEPARATE calls — the remote browser agent has a ~25-step internal budget per call, and long single calls risk client-side timeouts. Example: instead of "log in, then go to settings, then update profile, then verify," make three calls: (1) log in & verify dashboard, (2) update settings, (3) verify profile change.

CREDENTIALS: pass them as PARAMETERS, not only in the description. Naming an account in \`description\` alone does not make the agent use it — it falls back to the environment's stored credential. Use \`username\`/\`password\` (or \`credentialId\`) for the run's identity, \`auth.username\`/\`auth.password\` to pin the precondition login, and \`loginCredentials\` for accounts the agent must use at a login form it hits PART-WAY through the task (e.g. set a password → bounced to sign-in → log in as the account you just created). Anything you specify beats the environment's default for every login in the run; the result reports the identity actually used under \`logins\`.`;

/**
 * Build the dynamic tool description including available environments/credentials.
 */
export function buildToolDescription(ctx: ProjectContext | null): string {
  if (!ctx) return BASE_DESCRIPTION;

  const envsWithCreds = ctx.environments.filter(e => e.credentials.length > 0);
  if (envsWithCreds.length === 0) {
    return `${BASE_DESCRIPTION}\n\nDETECTED PROJECT: "${ctx.project.name}" (repo: ${ctx.repoName}). No credentials configured — provide username/password if the app requires login.`;
  }

  const lines: string[] = [
    `\n\nDETECTED PROJECT: "${ctx.project.name}" (repo: ${ctx.repoName})`,
    `\nAVAILABLE ENVIRONMENTS & CREDENTIALS (pass environmentId + credentialId for authenticated testing):`,
  ];

  for (const env of envsWithCreds) {
    const defaultTag = env.isDefault ? ' [default]' : '';
    lines.push(`\n  Environment: "${env.name}" (${env.uuid})${defaultTag}${env.url ? ` — ${env.url}` : ''}`);
    for (const cred of env.credentials) {
      // The backend contract surfaces credential LABELS (never passwords). The
      // uuid/role are optional — shown only when the backend includes them.
      const idPart = cred.uuid ? ` (${cred.uuid})` : '';
      let line = `    - "${cred.label}"${idPart} — user: ${cred.username}`;
      if (cred.role) line += `, role: ${cred.role}`;
      lines.push(line);
    }
  }

  lines.push(`\nTo use: pass environmentId and credentialId from above. Or provide username/password directly.`);

  return BASE_DESCRIPTION + lines.join('\n');
}

/**
 * Build the full tool definition, optionally enriched with project context.
 */
export function buildTestPageChangesTool(ctx: ProjectContext | null): Tool {
  return {
    name: "check_app_in_browser",
    title: "Run E2E Browser Test",
    annotations: WRITES,
    description: buildToolDescription(ctx),
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Natural language description of what to test or evaluate (e.g., 'Does the login form validate empty fields?' or 'Navigate to the homepage and verify the hero section loads')",
          minLength: 1
        },
        url: {
          type: "string",
          description: "URL to navigate to. Can be any public URL (https://example.com) OR a localhost/local dev server URL. For localhost URLs, a secure tunnel is automatically created — just make sure your dev server is running on that port."
        },
        environmentId: {
          type: "string",
          description: "UUID of a specific environment to use for this test. See available environments in the tool description above."
        },
        credentialId: {
          type: "string",
          description: "UUID of a specific credential to use for login. See available credentials in the tool description above."
        },
        credentialRole: {
          type: "string",
          description: "Pick a credential by role (e.g. 'admin', 'guest') from the resolved environment"
        },
        username: {
          type: "string",
          description: "A real, existing account email for the target app. Do NOT invent or guess credentials — use one from the available credentials listed above, or ask the user. The browser agent will type this into the login form. Takes precedence over the environment's default credential for EVERY login in the run."
        },
        password: {
          type: "string",
          description: "The real password for the username above. Do NOT guess or use placeholder passwords — use credentials from the list above or ask the user."
        },
        loginCredentials: {
          type: "array",
          description: "Accounts the agent may sign in as when it hits a login form DURING the task — not just the first login. Use this for flows that authenticate part-way through, e.g. set a password, get bounced to sign-in, then log in as the account you just provisioned. Stating credentials only in `description` is not enough: pass them here and the agent uses exactly these values. Overrides the environment's default credential.",
          items: {
            type: "object",
            properties: {
              username: { type: "string", description: "Account email/username to type into the login form." },
              password: { type: "string", description: "That account's password." },
              label: { type: "string", description: "Optional human label (e.g. 'newly invited user') to disambiguate in the task text." }
            },
            required: ["username", "password"],
            additionalProperties: false
          }
        },
        useEnvironmentCredentials: {
          type: "boolean",
          description: "Default true. Set false to forbid the agent from ever auto-filling the environment's stored credentials — it signs in only as an account this call named (username/password, credentialId, credentialRole, loginCredentials, or auth.username), or not at all. Use when a run must prove a SPECIFIC account's experience and a silent fallback to the default test user would invalidate it."
        },
        repoName: {
          type: "string",
          description: "GitHub repository name (e.g. 'my-org/my-repo'). Auto-detected from the current git repo — only provide this if you want to run against a different project than the one you're in."
        },
        auth: {
          type: "object",
          description: "Optional auth-precondition for a 'log in THEN deep-navigate' check. Set precondition:'login' to authenticate first, then land on deepUrl. Use this instead of hoping the agent signs itself in at a login wall. Pass username/password here to pin WHICH account it authenticates as; omit them to use the environment's default credential.",
          properties: {
            environmentId: {
              type: "string",
              description: "UUID of the environment whose credentials to log in with. See available environments in the tool description above."
            },
            username: {
              type: "string",
              description: "Account to authenticate as for the precondition login. Overrides the environment's default credential."
            },
            password: {
              type: "string",
              description: "Password for auth.username."
            },
            precondition: {
              type: "string",
              enum: ["login", "none"],
              description: "'login' = authenticate before evaluating; 'none' (default) = no login precondition."
            },
            entryUrl: {
              type: "string",
              description: "Optional URL of the login page to authenticate on."
            },
            deepUrl: {
              type: "string",
              description: "Optional URL to navigate to and evaluate AFTER login (e.g. a deep settings page). Falls back to `url` if omitted."
            },
          },
          additionalProperties: false
        },
      },
      required: ["description", "url"],
      additionalProperties: false
    },
  };
}

/**
 * Build the validated tool with schema and handler.
 */
export function buildValidatedTestPageChangesTool(ctx: ProjectContext | null): ValidatedTool {
  const tool = buildTestPageChangesTool(ctx);
  return {
    ...tool,
    inputSchema: TestPageChangesInputSchema,
    handler: testPageChangesHandler,
  };
}
