import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TestCaseInputSchema, ValidatedTool } from '../types/index.js';
import { testCaseHandler } from '../handlers/testCaseHandler.js';

const DESCRIPTION = `Manage individual test cases within a suite. Pass an "action":
  - "create" {name, description, agentTaskDescription, suiteUuid|(suiteName+project), relativeUrl?, maxSteps?} → add a test case (NOT auto-run).
  - "update" {testUuid, name?, description?, agentTaskDescription?} → patch a test case.
  - "delete" {testUuid, confirm?} → soft-delete (DESTRUCTIVE; requires confirmation).`;

export function buildTestCaseTool(): Tool {
  return {
    name: 'test_case',
    title: 'Test Case',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'Operation to perform.' },
        testUuid: { type: 'string', description: '[update/delete] Test case UUID.' },
        name: { type: 'string', description: 'Test case name.' },
        description: { type: 'string', description: 'Test case description.' },
        agentTaskDescription: { type: 'string', description: "What the AI agent should do and verify." },
        suiteUuid: { type: 'string', description: '[create] Suite UUID.' },
        suiteName: { type: 'string', description: '[create] Suite name (requires a project identifier).' },
        projectUuid: { type: 'string', description: '[create] Project UUID (or projectName).' },
        projectName: { type: 'string', description: '[create] Project name (or projectUuid).' },
        relativeUrl: { type: 'string', description: '[create] Starting path, must start with "/".' },
        maxSteps: { type: 'number', description: '[create] Max agent steps (1..100).' },
        confirm: { type: 'boolean', description: '[delete] Set true to confirm deletion (when the client cannot prompt).' },
      },
      required: ['action'],
      oneOf: [
        { properties: { action: { const: 'create' } }, required: ['action', 'name', 'description', 'agentTaskDescription'] },
        { properties: { action: { const: 'update' } }, required: ['action', 'testUuid'] },
        { properties: { action: { const: 'delete' } }, required: ['action', 'testUuid'] },
      ],
      additionalProperties: false,
    },
  };
}

export function buildValidatedTestCaseTool(): ValidatedTool {
  return { ...buildTestCaseTool(), inputSchema: TestCaseInputSchema, handler: testCaseHandler };
}
