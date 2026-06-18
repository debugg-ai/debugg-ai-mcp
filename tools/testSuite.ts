import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TestSuiteInputSchema, ValidatedTool } from '../types/index.js';
import { testSuiteHandler } from '../handlers/testSuiteHandler.js';

const DESCRIPTION = `Manage and run test suites. Identify a suite by suiteUuid, or suiteName + a project identifier (projectUuid|projectName). Pass an "action":
  - "list"    {projectUuid|projectName, search?, page?, pageSize?} → paginated suites with status/pass-rate.
  - "create"  {name, description, projectUuid|projectName} → create a suite.
  - "run"     {suiteUuid|(suiteName+project), targetUrl?} → run all tests async. Poll with action:"results".
  - "results" {suiteUuid|(suiteName+project)} → suite + per-test outcomes.
  - "delete"  {suiteUuid|(suiteName+project), confirm?} → soft-delete (DESTRUCTIVE; requires confirmation).`;

const PROJECT_PROPS = {
  projectUuid: { type: 'string', description: 'Project UUID (or projectName).' },
  projectName: { type: 'string', description: 'Project name (or projectUuid).' },
};
const SUITE_PROPS = {
  suiteUuid: { type: 'string', description: 'Test suite UUID.' },
  suiteName: { type: 'string', description: 'Test suite name (requires a project identifier).' },
};

export function buildTestSuiteTool(): Tool {
  return {
    name: 'test_suite',
    title: 'Test Suite',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'run', 'results', 'delete'], description: 'Operation to perform.' },
        ...SUITE_PROPS,
        ...PROJECT_PROPS,
        name: { type: 'string', description: '[create] Suite name.' },
        description: { type: 'string', description: '[create] Suite description.' },
        search: { type: 'string', description: '[list] Text filter over name/description.' },
        page: { type: 'number', description: '[list] Page (1-indexed).' },
        pageSize: { type: 'number', description: '[list] Page size (1..100).' },
        targetUrl: { type: 'string', description: '[run] Override the default test target (full URL).' },
        confirm: { type: 'boolean', description: '[delete] Set true to confirm deletion (when the client cannot prompt).' },
      },
      required: ['action'],
      oneOf: [
        { properties: { action: { const: 'list' } }, required: ['action'] },
        { properties: { action: { const: 'create' } }, required: ['action', 'name', 'description'] },
        { properties: { action: { const: 'run' } }, required: ['action'] },
        { properties: { action: { const: 'results' } }, required: ['action'] },
        { properties: { action: { const: 'delete' } }, required: ['action'] },
      ],
      additionalProperties: false,
    },
  };
}

export function buildValidatedTestSuiteTool(): ValidatedTool {
  return { ...buildTestSuiteTool(), inputSchema: TestSuiteInputSchema, handler: testSuiteHandler };
}
