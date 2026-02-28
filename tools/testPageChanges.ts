/**
 * Test Page Changes Tool Definition
 * Defines the check_app_in_browser tool with proper validation
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TestPageChangesInputSchema, ValidatedTool } from '../types/index.js';
import { testPageChangesHandler } from '../handlers/testPageChangesHandler.js';

/**
 * Tool definition for testing page changes with DebuggAI
 */
export const testPageChangesTool: Tool = {
  name: "check_app_in_browser",
  title: "Run E2E Browser Test",
  description: "Give an AI agent eyes on a live website or app. The agent browses it, interacts with it, and tells you whether a given task or check passed. Works on localhost or any URL. Use for visual QA, flow validation, regression checks, or anything that needs a real browser to verify.\n\nLOCALHOST SUPPORT: Pass any localhost URL (e.g. http://localhost:3000) and it Just Works. A secure tunnel is automatically created so the remote browser can reach your local dev server — no manual ngrok setup, no port forwarding, no config. Supports localhost, 127.0.0.1, 0.0.0.0, [::1], and private IPs (192.168.x.x, 10.x.x.x). The tunnel stays alive for 55 minutes and is reused across calls to the same port.",
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
        description: "URL to navigate to. Can be any public URL (https://example.com) OR a localhost/local dev server URL. For localhost URLs (http://localhost:3000, http://127.0.0.1:8080, etc.), a secure tunnel is automatically created so the remote browser can reach your machine — just make sure your dev server is running on that port. No extra setup needed."
      },
      environmentId: {
        type: "string",
        description: "UUID of a specific environment to use for this test"
      },
      credentialId: {
        type: "string",
        description: "UUID of a specific credential to use for login"
      },
      credentialRole: {
        type: "string",
        description: "Pick a credential by role (e.g. 'admin', 'guest') from the resolved environment"
      },
      username: {
        type: "string",
        description: "Username to log in with (creates or updates a credential idempotently)"
      },
      password: {
        type: "string",
        description: "Password to log in with (used together with username)"
      },
    },
    required: ["description", "url"],
    additionalProperties: false
  },
};

/**
 * Validated tool with schema and handler
 */
export const validatedTestPageChangesTool: ValidatedTool = {
  ...testPageChangesTool,
  inputSchema: TestPageChangesInputSchema,
  handler: testPageChangesHandler,
};