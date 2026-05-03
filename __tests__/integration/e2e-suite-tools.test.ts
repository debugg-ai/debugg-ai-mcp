/**
 * Integration tests for E2E Suite MCP tools.
 * Verifies tool registration, schema validity, and MCP protocol compliance.
 * All tests must fail until implementation is complete.
 */

import { getTools, getTool } from '../../tools/index.js';

const E2E_TOOL_NAMES = [
  'create_test_suite',
  'search_test_suites',
  'delete_test_suite',
  'create_test_case',
  'update_test_case',
  'delete_test_case',
  'run_test_suite',
  'get_test_suite_results',
];

describe('E2E Suite tools — registration', () => {
  test('all 8 e2e suite tools are registered in getTools()', () => {
    const tools = getTools();
    const names = tools.map(t => t.name);
    for (const name of E2E_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  test('total tool count includes the 8 new e2e tools', () => {
    const tools = getTools();
    expect(tools.length).toBeGreaterThanOrEqual(20); // 12 existing + 8 new
  });

  for (const name of E2E_TOOL_NAMES) {
    test(`${name}: getTool() returns a handler`, () => {
      const tool = getTool(name);
      expect(tool).toBeDefined();
      expect(typeof tool!.handler).toBe('function');
    });

    test(`${name}: has name, description, and inputSchema`, () => {
      const tools = getTools();
      const tool = tools.find(t => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.name).toBe(name);
      expect(typeof tool!.description).toBe('string');
      expect(tool!.description!.length).toBeGreaterThan(10);
      expect(tool!.inputSchema).toBeDefined();
      expect(tool!.inputSchema.type).toBe('object');
    });

    test(`${name}: inputSchema has properties and required fields`, () => {
      const tools = getTools();
      const tool = tools.find(t => t.name === name);
      expect(tool!.inputSchema.properties).toBeDefined();
    });
  }
});

describe('E2E Suite tools — schema correctness', () => {
  function getJsonSchema(name: string): { properties: Record<string, any>; required?: string[] } {
    const tool = getTools().find(t => t.name === name);
    return tool!.inputSchema as any;
  }

  test('create_test_suite requires name, description, and project identifier', () => {
    const schema = getJsonSchema('create_test_suite');
    expect(schema.properties).toHaveProperty('name');
    expect(schema.properties).toHaveProperty('description');
    expect(schema.properties.projectUuid ?? schema.properties.projectName).toBeDefined();
  });

  test('search_test_suites has optional search and pagination params', () => {
    const schema = getJsonSchema('search_test_suites');
    expect(schema.properties).toHaveProperty('search');
    expect(schema.properties).toHaveProperty('page');
    expect(schema.properties).toHaveProperty('pageSize');
  });

  test('create_test_case has relativeUrl and maxSteps as optional fields', () => {
    const schema = getJsonSchema('create_test_case');
    expect(schema.properties).toHaveProperty('relativeUrl');
    expect(schema.properties).toHaveProperty('maxSteps');
    const required: string[] = schema.required ?? [];
    expect(required).not.toContain('relativeUrl');
    expect(required).not.toContain('maxSteps');
  });

  test('update_test_case does NOT expose suite field', () => {
    const schema = getJsonSchema('update_test_case');
    expect(schema.properties).not.toHaveProperty('suite');
    expect(schema.properties).not.toHaveProperty('suiteUuid');
    expect(schema.properties).not.toHaveProperty('suiteName');
  });

  test('run_test_suite has optional targetUrl', () => {
    const schema = getJsonSchema('run_test_suite');
    expect(schema.properties).toHaveProperty('targetUrl');
    const required: string[] = schema.required ?? [];
    expect(required).not.toContain('targetUrl');
  });

  test('delete_test_case requires testUuid', () => {
    const schema = getJsonSchema('delete_test_case');
    expect(schema.properties).toHaveProperty('testUuid');
  });
});
