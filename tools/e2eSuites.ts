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
  name: "list_tests",
  title: "List E2E Tests",
  description: "List all browser tests run for your project with their status and results.",
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
  name: "list_test_suites",
  title: "List Test Suites",
  description: "List test suites for your project. A suite is a named group of related browser tests covering a feature or workflow.",
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
  name: "create_test_suite",
  title: "Create Test Suite",
  description: "Generate a suite of browser tests for a feature or user workflow. Describe what to test and the AI writes and queues the tests. Returns a suite UUID — use get_test_status to poll results.",
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
  name: "create_commit_suite",
  title: "Create Commit Test Suite",
  description: "Generate browser tests targeted at a specific code change or commit. Describe what changed and the AI creates tests to verify it works in the browser. Returns a suite UUID — use get_test_status to poll results.",
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
  name: "list_commit_suites",
  title: "List Commit Test Suites",
  description: "List commit-based test suites generated from code changes.",
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
  name: "get_test_status",
  title: "Get Test Suite Status",
  description: "Get the status and results of a test suite by UUID. Returns pass/fail per test, screenshots, and error details. Poll this after create_test_suite or create_commit_suite.",
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