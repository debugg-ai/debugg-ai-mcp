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
  description: "Give an AI agent eyes on a live website or app. The agent browses it, interacts with it, and tells you whether a given task or check passed. Works on localhost or any URL. Use for visual QA, flow validation, regression checks, or anything that needs a real browser to verify.",
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
        description: "Target URL for the browser agent to navigate to (e.g., 'https://example.com' or 'http://localhost:3000'). Use this for external URLs. For local dev servers, use localPort instead."
      },
      localPort: {
        type: "number",
        description: "Port of your local dev server (e.g. 3000, 8080). A secure tunnel is created automatically so the remote browser can reach it.",
        minimum: 1,
        maximum: 65535
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
    required: ["description"],
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