/**
 * Test Page Changes Tool Definition
 * Defines the check_app_in_browser tool with proper validation.
 * Tool description is enriched at startup with available environments/credentials.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TestPageChangesInputSchema, ValidatedTool } from '../types/index.js';
import { testPageChangesHandler } from '../handlers/testPageChangesHandler.js';
import { ProjectContext } from '../services/projectContext.js';

const BASE_DESCRIPTION = `Give an AI agent eyes on a live website or app. The agent browses it, interacts with it, and tells you whether a given task or check passed. Works on localhost or any URL. Use for visual QA, flow validation, regression checks, or anything that needs a real browser to verify.

LOCALHOST SUPPORT: Pass any localhost URL (e.g. http://localhost:3000) and it Just Works. A secure tunnel is automatically created so the remote browser can reach your local dev server — no manual ngrok setup, no port forwarding, no config.`;

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
    lines.push(`\n  Environment: "${env.name}" (${env.uuid})${env.url ? ` — ${env.url}` : ''}`);
    for (const cred of env.credentials) {
      const parts = [`    - "${cred.label}" (${cred.uuid}) — user: ${cred.username}`];
      if (cred.role) parts[0] += `, role: ${cred.role}`;
      lines.push(parts[0]);
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
          description: "A real, existing account email for the target app. Do NOT invent or guess credentials — use one from the available credentials listed above, or ask the user. The browser agent will type this into the login form."
        },
        password: {
          type: "string",
          description: "The real password for the username above. Do NOT guess or use placeholder passwords — use credentials from the list above or ask the user."
        },
        repoName: {
          type: "string",
          description: "GitHub repository name (e.g. 'my-org/my-repo'). Auto-detected from the current git repo — only provide this if you want to run against a different project than the one you're in."
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
