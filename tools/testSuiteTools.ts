import { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CreateTestSuiteInputSchema,
  SearchTestSuitesInputSchema,
  DeleteTestSuiteInputSchema,
  CreateTestCaseInputSchema,
  UpdateTestCaseInputSchema,
  DeleteTestCaseInputSchema,
  RunTestSuiteInputSchema,
  GetTestSuiteResultsInputSchema,
  ValidatedTool,
} from '../types/index.js';
import { createTestSuiteHandler } from '../handlers/createTestSuiteHandler.js';
import { searchTestSuitesHandler } from '../handlers/searchTestSuitesHandler.js';
import { deleteTestSuiteHandler } from '../handlers/deleteTestSuiteHandler.js';
import { createTestCaseHandler } from '../handlers/createTestCaseHandler.js';
import { updateTestCaseHandler } from '../handlers/updateTestCaseHandler.js';
import { deleteTestCaseHandler } from '../handlers/deleteTestCaseHandler.js';
import { runTestSuiteHandler } from '../handlers/runTestSuiteHandler.js';
import { getTestSuiteResultsHandler } from '../handlers/getTestSuiteResultsHandler.js';

const PROJECT_PROPS = {
  projectUuid: { type: 'string', description: 'Project UUID. Provide projectUuid OR projectName.' },
  projectName: { type: 'string', description: 'Project name (case-insensitive exact match). Provide projectUuid OR projectName.' },
};

const SUITE_PROPS = {
  suiteUuid: { type: 'string', description: 'Test suite UUID. Provide suiteUuid OR (suiteName + project identifier).' },
  suiteName: { type: 'string', description: 'Test suite name (case-insensitive exact match). Requires projectUuid or projectName.' },
};

// ── create_test_suite ─────────────────────────────────────────────────────────

export function buildCreateTestSuiteTool(): Tool {
  return {
    name: 'create_test_suite',
    title: 'Create Test Suite',
    description: 'Create a named test suite for a project. A test suite is a collection of test cases that can be run together. Requires name, description, and a project identifier (projectUuid or projectName). Returns {uuid, name, description, runStatus, testsCount}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Suite name. Required.', minLength: 1 },
        description: { type: 'string', description: 'Suite description. Required.', minLength: 1 },
        ...PROJECT_PROPS,
      },
      required: ['name', 'description'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedCreateTestSuiteTool(): ValidatedTool {
  return { ...buildCreateTestSuiteTool(), inputSchema: CreateTestSuiteInputSchema, handler: createTestSuiteHandler };
}

// ── search_test_suites ────────────────────────────────────────────────────────

export function buildSearchTestSuitesTool(): Tool {
  return {
    name: 'search_test_suites',
    title: 'Search Test Suites',
    description: 'List and search test suites for a project. Returns paginated results with suite status, test counts, pass rates, and last run timestamps. Requires a project identifier (projectUuid or projectName). Optional: search text filter, page, pageSize (1-100, default 20).',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_PROPS,
        search: { type: 'string', description: 'Optional text filter applied to suite name and description.' },
        page: { type: 'number', description: 'Page number (default 1).', minimum: 1 },
        pageSize: { type: 'number', description: 'Results per page (default 20, max 100).', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedSearchTestSuitesTool(): ValidatedTool {
  return { ...buildSearchTestSuitesTool(), inputSchema: SearchTestSuitesInputSchema, handler: searchTestSuitesHandler };
}

// ── delete_test_suite ─────────────────────────────────────────────────────────

export function buildDeleteTestSuiteTool(): Tool {
  return {
    name: 'delete_test_suite',
    title: 'Delete Test Suite',
    description: 'Disable (soft-delete) a test suite. The suite and its tests are hidden from default list queries but not permanently removed. Accepts suiteUuid directly, or suiteName + project identifier for name-based lookup. Returns {deleted: true, suiteUuid}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SUITE_PROPS,
        ...PROJECT_PROPS,
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedDeleteTestSuiteTool(): ValidatedTool {
  return { ...buildDeleteTestSuiteTool(), inputSchema: DeleteTestSuiteInputSchema, handler: deleteTestSuiteHandler };
}

// ── create_test_case ──────────────────────────────────────────────────────────

export function buildCreateTestCaseTool(): Tool {
  return {
    name: 'create_test_case',
    title: 'Create Test Case',
    description: 'Create an individual test case and assign it to a test suite. The test is NOT automatically executed. Requires name, description, agentTaskDescription (the AI agent\'s goal), and suite + project identifiers. Optional: relativeUrl (must start with "/") and maxSteps (1-100). Returns {uuid, name, description, agentTaskDescription, suite, project, runCount}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Test case name. Required.', minLength: 1 },
        description: { type: 'string', description: 'Test case description. Required.', minLength: 1 },
        agentTaskDescription: { type: 'string', description: 'Natural language description of what the AI agent should do and verify. Required.', minLength: 1 },
        ...SUITE_PROPS,
        ...PROJECT_PROPS,
        relativeUrl: { type: 'string', description: 'Optional starting URL path relative to the app root, e.g. "/login". Must start with "/".' },
        maxSteps: { type: 'number', description: 'Maximum agent steps (1-100).', minimum: 1, maximum: 100 },
      },
      required: ['name', 'description', 'agentTaskDescription'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedCreateTestCaseTool(): ValidatedTool {
  return { ...buildCreateTestCaseTool(), inputSchema: CreateTestCaseInputSchema, handler: createTestCaseHandler };
}

// ── update_test_case ──────────────────────────────────────────────────────────

export function buildUpdateTestCaseTool(): Tool {
  return {
    name: 'update_test_case',
    title: 'Update Test Case',
    description: 'Update a test case\'s name, description, or agentTaskDescription. Requires testUuid. At least one of name, description, or agentTaskDescription must be provided. Returns the updated test case.',
    inputSchema: {
      type: 'object',
      properties: {
        testUuid: { type: 'string', description: 'UUID of the test case to update. Required.' },
        name: { type: 'string', description: 'New name for the test case.', minLength: 1 },
        description: { type: 'string', description: 'New description.', minLength: 1 },
        agentTaskDescription: { type: 'string', description: 'New agent task description.', minLength: 1 },
      },
      required: ['testUuid'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedUpdateTestCaseTool(): ValidatedTool {
  return { ...buildUpdateTestCaseTool(), inputSchema: UpdateTestCaseInputSchema, handler: updateTestCaseHandler };
}

// ── delete_test_case ──────────────────────────────────────────────────────────

export function buildDeleteTestCaseTool(): Tool {
  return {
    name: 'delete_test_case',
    title: 'Delete Test Case',
    description: 'Disable (soft-delete) a test case. The test is hidden from default list queries but not permanently removed. Requires testUuid. Returns {deleted: true, testUuid}.',
    inputSchema: {
      type: 'object',
      properties: {
        testUuid: { type: 'string', description: 'UUID of the test case to delete. Required.' },
      },
      required: ['testUuid'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedDeleteTestCaseTool(): ValidatedTool {
  return { ...buildDeleteTestCaseTool(), inputSchema: DeleteTestCaseInputSchema, handler: deleteTestCaseHandler };
}

// ── run_test_suite ────────────────────────────────────────────────────────────

export function buildRunTestSuiteTool(): Tool {
  return {
    name: 'run_test_suite',
    title: 'Run Test Suite',
    description: 'Trigger all test cases in a suite to run asynchronously. Accepts suiteUuid directly, or suiteName + project identifier. Optional: targetUrl to override the default test target. Returns {suiteUuid, runStatus, testsTriggered, note}. Use get_test_suite_results to poll for results.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SUITE_PROPS,
        ...PROJECT_PROPS,
        targetUrl: { type: 'string', description: 'Optional URL to run tests against (overrides default). Must be a full URL.' },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedRunTestSuiteTool(): ValidatedTool {
  return { ...buildRunTestSuiteTool(), inputSchema: RunTestSuiteInputSchema, handler: runTestSuiteHandler };
}

// ── get_test_suite_results ────────────────────────────────────────────────────

export function buildGetTestSuiteResultsTool(): Tool {
  return {
    name: 'get_test_suite_results',
    title: 'Get Test Suite Results',
    description: 'Fetch a test suite with full per-test results. Returns suite-level status (NEVER_RUN, PENDING, RUNNING, COMPLETED, ERROR), pass rate, last run timestamp, and per-test outcomes (PASS, FAIL, ERROR, TIMEOUT, etc.) with execution times. Accepts suiteUuid directly or suiteName + project identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SUITE_PROPS,
        ...PROJECT_PROPS,
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedGetTestSuiteResultsTool(): ValidatedTool {
  return { ...buildGetTestSuiteResultsTool(), inputSchema: GetTestSuiteResultsInputSchema, handler: getTestSuiteResultsHandler };
}
