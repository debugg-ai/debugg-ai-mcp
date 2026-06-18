/**
 * Integration tests for the consolidated test-management tools (epic yg7o6).
 * The former 8 per-verb e2e tools are now two action tools: test_suite + test_case.
 */

import { getTools, getTool } from '../../tools/index.js';

describe('test-management tools — consolidated surface', () => {
  test('test_suite and test_case are registered (the 8 per-verb tools are gone)', () => {
    const names = getTools().map(t => t.name);
    expect(names).toContain('test_suite');
    expect(names).toContain('test_case');
    for (const old of ['create_test_suite', 'search_test_suites', 'delete_test_suite', 'create_test_case', 'update_test_case', 'delete_test_case', 'run_test_suite', 'get_test_suite_results']) {
      expect(names).not.toContain(old);
    }
  });

  test('test_suite exposes list/create/run/results/delete actions + a handler', () => {
    const tool = getTool('test_suite');
    expect(tool).toBeDefined();
    expect(typeof tool!.handler).toBe('function');
    const actions = (getTools().find(t => t.name === 'test_suite')!.inputSchema as any).properties.action.enum;
    expect(actions.sort()).toEqual(['create', 'delete', 'list', 'results', 'run']);
  });

  test('test_case exposes create/update/delete actions + a handler', () => {
    const tool = getTool('test_case');
    expect(tool).toBeDefined();
    expect(typeof tool!.handler).toBe('function');
    const actions = (getTools().find(t => t.name === 'test_case')!.inputSchema as any).properties.action.enum;
    expect(actions.sort()).toEqual(['create', 'delete', 'update']);
  });

  test('test_suite validates per-action params', () => {
    const tool = getTool('test_suite')!;
    expect(tool.inputSchema.safeParse({ action: 'create', name: 'S', description: 'd', projectName: 'P' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ action: 'create' }).success).toBe(false); // missing name/description
    expect(tool.inputSchema.safeParse({ action: 'run', suiteUuid: '00000000-0000-0000-0000-000000000001' }).success).toBe(true);
  });

  test('test_case create requires agentTaskDescription; delete needs testUuid', () => {
    const tool = getTool('test_case')!;
    const UUID = '00000000-0000-0000-0000-000000000001';
    expect(tool.inputSchema.safeParse({ action: 'create', name: 'n', description: 'd', agentTaskDescription: 'go', suiteUuid: UUID }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ action: 'create', name: 'n', description: 'd', suiteUuid: UUID }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ action: 'delete', testUuid: UUID }).success).toBe(true);
  });
});
