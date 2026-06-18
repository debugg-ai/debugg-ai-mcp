/**
 * Consolidated action-based tool schemas (epic yg7o6, C2).
 *
 * Each entity tool validates params per `action`; wrong-action params and
 * unknown actions are rejected. update_project/delete_project are intentionally
 * absent from the project schema (cut, D8).
 */

import { describe, test, expect } from '@jest/globals';
import {
  ProjectInputSchema,
  EnvironmentInputSchema,
  TestSuiteInputSchema,
  TestCaseInputSchema,
  ExecutionsInputSchema,
} from '../../types/index.js';

const UUID = '00000000-0000-0000-0000-000000000001';

describe('ProjectInputSchema', () => {
  test('get requires uuid', () => {
    expect(ProjectInputSchema.safeParse({ action: 'get', uuid: UUID }).success).toBe(true);
    expect(ProjectInputSchema.safeParse({ action: 'get' }).success).toBe(false);
  });
  test('list accepts q/page/pageSize', () => {
    expect(ProjectInputSchema.safeParse({ action: 'list' }).success).toBe(true);
    expect(ProjectInputSchema.safeParse({ action: 'list', q: 'app', page: 1 }).success).toBe(true);
  });
  test('create requires name + platform + a team + a repo', () => {
    expect(ProjectInputSchema.safeParse({ action: 'create', name: 'X', platform: 'web', teamName: 'T', repoName: 'o/r' }).success).toBe(true);
    expect(ProjectInputSchema.safeParse({ action: 'create', name: 'X', platform: 'web' }).success).toBe(false); // no team/repo
    expect(ProjectInputSchema.safeParse({ action: 'create', name: 'X', platform: 'web', teamName: 'T', teamUuid: UUID, repoName: 'o/r' }).success).toBe(false); // both team forms
  });
  test('rejects cut actions update/delete', () => {
    expect(ProjectInputSchema.safeParse({ action: 'update', uuid: UUID, name: 'n' }).success).toBe(false);
    expect(ProjectInputSchema.safeParse({ action: 'delete', uuid: UUID }).success).toBe(false);
  });
  test('rejects unknown action', () => {
    expect(ProjectInputSchema.safeParse({ action: 'frobnicate' }).success).toBe(false);
  });
});

describe('EnvironmentInputSchema', () => {
  test('full CRUD actions validate', () => {
    expect(EnvironmentInputSchema.safeParse({ action: 'get', uuid: UUID }).success).toBe(true);
    expect(EnvironmentInputSchema.safeParse({ action: 'list', q: 'staging' }).success).toBe(true);
    expect(EnvironmentInputSchema.safeParse({ action: 'create', name: 'staging', url: 'https://s.example.com' }).success).toBe(true);
    expect(EnvironmentInputSchema.safeParse({ action: 'update', uuid: UUID, name: 'prod' }).success).toBe(true);
    expect(EnvironmentInputSchema.safeParse({ action: 'delete', uuid: UUID }).success).toBe(true);
  });
  test('create keeps nested credentials[]', () => {
    const r = EnvironmentInputSchema.safeParse({ action: 'create', name: 'e', url: 'https://e.example.com', credentials: [{ label: 'admin', username: 'a@b.co', password: 'pw' }] });
    expect(r.success).toBe(true);
  });
  test('delete accepts optional confirm', () => {
    expect(EnvironmentInputSchema.safeParse({ action: 'delete', uuid: UUID, confirm: true }).success).toBe(true);
  });
});

describe('TestSuiteInputSchema', () => {
  test('list/create/run/results/delete validate', () => {
    expect(TestSuiteInputSchema.safeParse({ action: 'list', projectName: 'P' }).success).toBe(true);
    expect(TestSuiteInputSchema.safeParse({ action: 'create', name: 'S', description: 'd', projectName: 'P' }).success).toBe(true);
    expect(TestSuiteInputSchema.safeParse({ action: 'run', suiteUuid: UUID }).success).toBe(true);
    expect(TestSuiteInputSchema.safeParse({ action: 'results', suiteUuid: UUID }).success).toBe(true);
    expect(TestSuiteInputSchema.safeParse({ action: 'delete', suiteUuid: UUID, confirm: true }).success).toBe(true);
  });
});

describe('TestCaseInputSchema', () => {
  test('create requires agentTaskDescription', () => {
    expect(TestCaseInputSchema.safeParse({ action: 'create', name: 'n', description: 'd', agentTaskDescription: 'do x', suiteUuid: UUID }).success).toBe(true);
    expect(TestCaseInputSchema.safeParse({ action: 'create', name: 'n', description: 'd', suiteUuid: UUID }).success).toBe(false);
  });
  test('update/delete by testUuid', () => {
    expect(TestCaseInputSchema.safeParse({ action: 'update', testUuid: UUID, name: 'n' }).success).toBe(true);
    expect(TestCaseInputSchema.safeParse({ action: 'delete', testUuid: UUID }).success).toBe(true);
  });
});

describe('ExecutionsInputSchema', () => {
  test('get requires uuid; list accepts status/projectUuid filters', () => {
    expect(ExecutionsInputSchema.safeParse({ action: 'get', uuid: UUID }).success).toBe(true);
    expect(ExecutionsInputSchema.safeParse({ action: 'get' }).success).toBe(false);
    expect(ExecutionsInputSchema.safeParse({ action: 'list', status: 'completed' }).success).toBe(true);
    expect(ExecutionsInputSchema.safeParse({ action: 'list', projectUuid: UUID, page: 2 }).success).toBe(true);
  });
});
