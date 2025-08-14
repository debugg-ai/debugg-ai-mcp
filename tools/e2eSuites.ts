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
  description: "List all E2E tests for this project",
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
        description: "Filter by test status"
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
  description: "List all E2E test suites for this project",
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
  description: "Create a new E2E test suite based on feature description and project context",
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
  description: "Create E2E test suite based on commit changes and modifications",
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
  description: "List all E2E commit suites for this project",
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
  description: "Get the current status and results of an E2E test suite or commit suite",
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