/**
 * Tool registry composition (epic yg7o6, C4).
 * The surface is exactly 8 action-based tools; the old per-verb tools and the
 * two cut tools (update_project, delete_project) are gone.
 */

import { getTools, getTool } from '../../tools/index.js';

const EXPECTED = [
  'check_app_in_browser',
  'probe_page',
  'trigger_crawl',
  'project',
  'environment',
  'test_suite',
  'test_case',
  'executions',
].sort();

describe('tool registry', () => {
  test('registers exactly the 8 expected tools', () => {
    const names = getTools().map(t => t.name).sort();
    expect(names).toEqual(EXPECTED);
  });

  test('cut tools (update_project, delete_project) are not registered', () => {
    const names = getTools().map(t => t.name);
    expect(names).not.toContain('update_project');
    expect(names).not.toContain('delete_project');
  });

  test('old per-verb CRUD tool names no longer resolve', () => {
    for (const old of ['search_projects', 'create_project', 'search_environments', 'create_environment', 'update_environment', 'delete_environment', 'search_executions']) {
      expect(getTool(old)).toBeUndefined();
    }
  });

  test('every entity tool exposes an action enum + a handler', () => {
    for (const name of ['project', 'environment', 'test_suite', 'test_case', 'executions']) {
      const def = getTools().find(t => t.name === name)!;
      expect(Array.isArray((def.inputSchema as any).properties.action.enum)).toBe(true);
      expect(typeof getTool(name)!.handler).toBe('function');
    }
  });

  test('project tool offers only get/list/create (update/delete cut)', () => {
    const actions = (getTools().find(t => t.name === 'project')!.inputSchema as any).properties.action.enum;
    expect(actions.sort()).toEqual(['create', 'get', 'list']);
  });

  // Regression (3.0.1): the Anthropic tool input_schema rejects top-level
  // oneOf/anyOf/allOf, and clients (Claude Code) SILENTLY DROP any tool whose
  // schema uses them. 3.0.0 shipped action tools with a top-level `oneOf`, so
  // project/environment/test_suite/test_case/executions vanished from the client
  // and only the 3 browser tools showed. Per-action required fields are enforced
  // by the Zod discriminated unions at call time instead.
  test('no tool input schema uses top-level oneOf/anyOf/allOf (Anthropic API rejects them)', () => {
    for (const t of getTools()) {
      const s = t.inputSchema as any;
      expect([t.name, 'oneOf', !!s.oneOf]).toEqual([t.name, 'oneOf', false]);
      expect([t.name, 'anyOf', !!s.anyOf]).toEqual([t.name, 'anyOf', false]);
      expect([t.name, 'allOf', !!s.allOf]).toEqual([t.name, 'allOf', false]);
    }
  });
});
