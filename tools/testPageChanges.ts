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
  description: "Run end-to-end browser tests using AI agents that interact with your web application like real users. Tests specific pages, features, or workflows by clicking buttons, filling forms, and validating behavior. Returns screenshots and detailed results.",
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
      filePath: {
        type: "string",
        description: "Absolute path to the main file being tested (helps provide context to the AI)"
      },
      repoName: {
        type: "string",
        description: "Name of your Git repository (e.g., 'my-web-app')"
      },
      branchName: {
        type: "string",
        description: "Current Git branch name (e.g., 'main', 'feature/login')"
      },
      repoPath: {
        type: "string",
        description: "Absolute path to your project's root directory"
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