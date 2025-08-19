/**
 * E2E Suite Tools
 * Provides tools for creating and managing E2E test suites and commit suites
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { 
  ListTestsInputSchema,
  ListTestSuitesInputSchema,
  CreateTestSuiteInputSchema,
  CreateCommitSuiteInputSchema,
  ListCommitSuitesInputSchema,
  GetTestStatusInputSchema,
  ValidatedTool
} from '../types/index.js';
import { 
  listTestsHandler,
  listTestSuitesHandler,
  createTestSuiteHandler,
  createCommitSuiteHandler,
  listCommitSuitesHandler,
  getTestStatusHandler
} from '../handlers/e2eSuiteHandlers.js';

/**
 * Tool for listing E2E tests
 */
export const listTestsTool: Tool = {
  name: "debugg_ai_list_tests",
  description: "View all end-to-end browser tests that have been run for your project. Shows test results, status, screenshots, and detailed execution logs.",
  inputSchema: {
    type: "object",
    properties: {
      repoName: {
        type: "string",
        description: "Filter tests by repository name (e.g., 'my-web-app')"
      },
      branchName: {
        type: "string",
        description: "Filter tests by Git branch name (e.g., 'main', 'feature/login')"
      },
      status: {
        type: "string",
        enum: ["pending", "running", "completed", "failed"],
        description: "Show only tests with this status: 'pending' (not started), 'running' (currently executing), 'completed' (finished successfully), 'failed' (had errors)"
      },
      page: {
        type: "number",
        description: "Page number for pagination",
        minimum: 1,
        default: 1
      },
      limit: {
        type: "number", 
        description: "Number of tests per page",
        minimum: 1,
        maximum: 100,
        default: 20
      }
    },
    additionalProperties: false
  },
};

/**
 * Tool for listing E2E test suites
 */
export const listTestSuitesTool: Tool = {
  name: "debugg_ai_list_test_suites",
  description: "View organized collections of related tests for your project. Test suites group multiple browser tests together (e.g., 'User Authentication Suite' containing login, logout, and password reset tests).",
  inputSchema: {
    type: "object",
    properties: {
      repoName: {
        type: "string",
        description: "Repository name to filter by"
      },
      branchName: {
        type: "string",
        description: "Branch name to filter by"
      },
      status: {
        type: "string",
        enum: ["pending", "running", "completed", "failed"],
        description: "Filter by suite status"
      },
      page: {
        type: "number",
        description: "Page number for pagination",
        minimum: 1,
        default: 1
      },
      limit: {
        type: "number",
        description: "Number of suites per page", 
        minimum: 1,
        maximum: 100,
        default: 20
      }
    },
    additionalProperties: false
  },
};

/**
 * Tool for creating test suites
 */
export const createTestSuiteTool: Tool = {
  name: "debugg_ai_create_test_suite",
  description: "Generate a comprehensive collection of browser tests for a specific feature or user workflow. AI creates multiple related tests that thoroughly validate functionality (e.g., create 'Shopping Cart Suite' with add item, remove item, checkout, and error handling tests).",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Description of the feature or functionality to create tests for",
        minLength: 1
      },
      repoName: {
        type: "string",
        description: "Repository name for context"
      },
      branchName: {
        type: "string",
        description: "Branch name for context"
      },
      repoPath: {
        type: "string", 
        description: "Local repository path"
      },
      filePath: {
        type: "string",
        description: "Specific file path related to the feature"
      }
    },
    required: ["description"],
    additionalProperties: false
  },
};

/**
 * Tool for creating commit-based test suites
 */
export const createCommitSuiteTool: Tool = {
  name: "debugg_ai_create_commit_suite",
  description: "Automatically generate browser tests based on your recent code changes. AI analyzes your Git commits and creates relevant tests to verify that your new features and bug fixes work correctly in the browser.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Description of the changes or commit to create tests for",
        minLength: 1
      },
      repoName: {
        type: "string",
        description: "Repository name for context"
      },
      branchName: {
        type: "string",
        description: "Branch name for context"
      },
      repoPath: {
        type: "string",
        description: "Local repository path"
      },
      filePath: {
        type: "string",
        description: "Specific file path related to the changes"
      }
    },
    required: ["description"],
    additionalProperties: false
  },
};

/**
 * Tool for listing commit suites
 */
export const listCommitSuitesTool: Tool = {
  name: "debugg_ai_list_commit_suites",
  description: "View all test suites that were automatically generated from your Git commits. These are collections of browser tests created to validate specific code changes.",
  inputSchema: {
    type: "object",
    properties: {
      repoName: {
        type: "string",
        description: "Repository name to filter by"
      },
      branchName: {
        type: "string",
        description: "Branch name to filter by"
      },
      status: {
        type: "string",
        enum: ["pending", "running", "completed", "failed"],
        description: "Filter by commit suite status"
      },
      page: {
        type: "number",
        description: "Page number for pagination",
        minimum: 1,
        default: 1
      },
      limit: {
        type: "number",
        description: "Number of commit suites per page",
        minimum: 1,
        maximum: 100,
        default: 20
      }
    },
    additionalProperties: false
  },
};

/**
 * Tool for getting test status
 */
export const getTestStatusTool: Tool = {
  name: "debugg_ai_get_test_status",
  description: "Check the progress and results of a running or completed test suite. Shows whether tests are still running, how many passed/failed, screenshots from test execution, and detailed error messages if any tests failed.",
  inputSchema: {
    type: "object",
    properties: {
      suiteUuid: {
        type: "string",
        description: "UUID of the test suite or commit suite to check status for",
        pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
      },
      suiteType: {
        type: "string",
        enum: ["test", "commit"],
        description: "Type of suite to check (test suite or commit suite)",
        default: "test"
      }
    },
    required: ["suiteUuid"],
    additionalProperties: false
  },
};

/**
 * Validated tools with schemas and handlers
 */
export const validatedE2ESuiteTools: ValidatedTool[] = [
  {
    ...listTestsTool,
    inputSchema: ListTestsInputSchema,
    handler: listTestsHandler
  },
  {
    ...listTestSuitesTool,
    inputSchema: ListTestSuitesInputSchema,
    handler: listTestSuitesHandler
  },
  {
    ...createTestSuiteTool,
    inputSchema: CreateTestSuiteInputSchema,
    handler: createTestSuiteHandler
  },
  {
    ...createCommitSuiteTool,
    inputSchema: CreateCommitSuiteInputSchema,
    handler: createCommitSuiteHandler
  },
  {
    ...listCommitSuitesTool,
    inputSchema: ListCommitSuitesInputSchema,
    handler: listCommitSuitesHandler
  },
  {
    ...getTestStatusTool,
    inputSchema: GetTestStatusInputSchema,
    handler: getTestStatusHandler
  }
];