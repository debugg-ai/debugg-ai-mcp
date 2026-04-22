/**
 * Trigger Crawl Tool Definition
 * Defines the trigger_crawl tool with proper validation.
 * Tool description is enriched at startup with available environments/credentials.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TriggerCrawlInputSchema, ValidatedTool } from '../types/index.js';
import { triggerCrawlHandler } from '../handlers/triggerCrawlHandler.js';
import { ProjectContext } from '../services/projectContext.js';

const BASE_DESCRIPTION = `Trigger a browser-agent crawl of a web app to build the project's knowledge graph. The crawl systematically explores pages, UI states, and navigation flows, then populates the backend's knowledge graph so future evaluations and tests have context about the app.

LOCALHOST SUPPORT: Pass any localhost URL (e.g. http://localhost:3000) and it Just Works. A secure tunnel is automatically created so the remote browser can reach your local dev server.

WHEN TO USE: after a significant new feature, a new environment, or when onboarding a project. NOT for per-change verification — use check_app_in_browser for that.

SCOPE: one crawl per call against one URL. The crawl is long-running (minutes to tens of minutes depending on app size) and populates backend state asynchronously; the tool returns the execution status once the workflow completes. This does NOT return pass/fail — it returns executionId + status + outcome.`;

export function buildTriggerCrawlDescription(ctx: ProjectContext | null): string {
  if (!ctx) return BASE_DESCRIPTION;

  const envsWithCreds = ctx.environments.filter(e => e.credentials.length > 0);
  if (envsWithCreds.length === 0) {
    return `${BASE_DESCRIPTION}\n\nDETECTED PROJECT: "${ctx.project.name}" (repo: ${ctx.repoName}). No credentials configured — provide username/password if the app requires login to crawl authenticated areas.`;
  }

  const lines: string[] = [
    `\n\nDETECTED PROJECT: "${ctx.project.name}" (repo: ${ctx.repoName})`,
    `\nAVAILABLE ENVIRONMENTS & CREDENTIALS (pass environmentId + credentialId to crawl authenticated areas):`,
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

export function buildTriggerCrawlTool(ctx: ProjectContext | null): Tool {
  return {
    name: 'trigger_crawl',
    title: 'Trigger App Crawl',
    description: buildTriggerCrawlDescription(ctx),
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to crawl. Can be any public URL or a localhost/local dev server URL. For localhost URLs, a secure tunnel is automatically created — just make sure your dev server is running on that port.',
        },
        projectUuid: {
          type: 'string',
          description: 'UUID of the project whose knowledge graph the crawl should populate. Auto-detected from the current git repo if omitted.',
        },
        environmentId: {
          type: 'string',
          description: 'UUID of a specific environment to use for the crawl. See available environments in the tool description above.',
        },
        credentialId: {
          type: 'string',
          description: 'UUID of a specific credential for authenticated crawls. See available credentials in the tool description above.',
        },
        credentialRole: {
          type: 'string',
          description: "Pick a credential by role (e.g. 'admin', 'guest') from the resolved environment.",
        },
        username: {
          type: 'string',
          description: 'A real, existing account email for the target app. Do NOT invent credentials — use one from the available credentials or ask the user.',
        },
        password: {
          type: 'string',
          description: 'The real password for the username above. Do NOT guess.',
        },
        headless: {
          type: 'boolean',
          description: 'Run the browser in headless mode. Defaults to backend configuration.',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Maximum wall-time the crawl may run, in seconds (1..1800). Backend enforces this per workflow execution.',
        },
        repoName: {
          type: 'string',
          description: "GitHub repository name (e.g. 'my-org/my-repo'). Auto-detected from the current git repo — only provide this to run against a different project.",
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedTriggerCrawlTool(ctx: ProjectContext | null): ValidatedTool {
  const tool = buildTriggerCrawlTool(ctx);
  return {
    ...tool,
    inputSchema: TriggerCrawlInputSchema,
    handler: triggerCrawlHandler,
  };
}
