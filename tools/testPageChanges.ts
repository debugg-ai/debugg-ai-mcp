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
  description: "Use DebuggAI to run & test UI changes that have been made with its User emulation agents",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Description of what page (relative url) and features should be tested.",
        minLength: 1
      },
      localPort: {
        type: "number",
        description: "Localhost port number where the app is running. Eg. 3000",
        minimum: 1,
        maximum: 65535
      },
      filePath: {
        type: "string",
        description: "Absolute path to the file to test"
      },
      repoName: {
        type: "string",
        description: "The name of the current repository"
      },
      branchName: {
        type: "string",
        description: "Current branch name"
      },
      repoPath: {
        type: "string",
        description: "Local path of the repo root"
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