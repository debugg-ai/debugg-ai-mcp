/**
 * Test Page Changes Tool Definition
 * Defines the debugg_ai_test_page_changes tool with proper validation
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TestPageChangesInputSchema, ValidatedTool } from '../types/index.js';
import { testPageChangesHandler } from '../handlers/testPageChangesHandler.js';

/**
 * Tool definition for testing page changes with DebuggAI
 */
export const testPageChangesTool: Tool = {
  name: "debugg_ai_test_page_changes",
  description: "Run end-to-end browser tests using AI agents that interact with your web application like real users. Tests specific pages, features, or workflows by clicking buttons, filling forms, and validating behavior. Returns screenshots and detailed results.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Natural language description of what to test (e.g., 'Test login form on /login page' or 'Click the submit button and verify success message appears')",
        minLength: 1
      },
      localPort: {
        type: "number",
        description: "Port number where your local development server is running (e.g., 3000 for React, 8080 for Vue)",
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