/**
 * Tests for searchEnvironmentsHandler — proof point for bead 5kw.
 *
 * Covers:
 *  - uuid mode: single-row env with credentials expanded inline
 *  - filter mode: paginated envs, each with creds inline
 *  - project resolution (projectUuid override AND git-repo auto-detect)
 *  - NoProjectResolved error when git + input both absent
 *  - NotFound on uuid mode with unknown env
 *  - DEFENSIVE: response NEVER contains a "password" key anywhere (even if the
 *    service accidentally leaks one — handler strips it)
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockFindProjectByRepoName = jest.fn<(repo: string) => Promise<any>>();
const mockGetEnvironment = jest.fn<(...args: any[]) => Promise<any>>();
const mockListEnvironmentsPaginated = jest.fn<(...args: any[]) => Promise<any>>();
const mockListCredentialsForEnvironment = jest.fn<(...args: any[]) => Promise<any>>();
const mockDetectRepoName = jest.fn<() => string | null>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    findProjectByRepoName: mockFindProjectByRepoName,
    getEnvironment: mockGetEnvironment,
    listEnvironmentsPaginated: mockListEnvironmentsPaginated,
    listCredentialsForEnvironment: mockListCredentialsForEnvironment,
  })),
}));

jest.unstable_mockModule('../../utils/gitContext.js', () => ({
  detectRepoName: mockDetectRepoName,
}));

let searchEnvironmentsHandler: typeof import('../../handlers/searchEnvironmentsHandler.js').searchEnvironmentsHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/searchEnvironmentsHandler.js');
  searchEnvironmentsHandler = mod.searchEnvironmentsHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };
const PROJECT_UUID = '11111111-1111-1111-1111-111111111111';
const ENV_UUID = '22222222-2222-2222-2222-222222222222';
const ENV_UUID_2 = '33333333-3333-3333-3333-333333333333';

const PROJECT = { uuid: PROJECT_UUID, name: 'debugg-ai/app', repo: { name: 'debugg-ai/app' } };
const ENV_A = { uuid: ENV_UUID, name: 'staging', url: 'https://stage.example', isActive: true };
const ENV_B = { uuid: ENV_UUID_2, name: 'prod', url: 'https://prod.example', isActive: true };

const CREDS_A = [
  { uuid: 'c-a-1', label: 'admin', username: 'admin@x', role: 'admin', environmentUuid: ENV_UUID },
  { uuid: 'c-a-2', label: 'guest', username: 'guest@x', role: 'guest', environmentUuid: ENV_UUID },
];
const CREDS_B = [
  { uuid: 'c-b-1', label: 'prod-admin', username: 'pa@x', role: 'admin', environmentUuid: ENV_UUID_2 },
];

describe('searchEnvironmentsHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
  });

  describe('project resolution', () => {
    test('projectUuid override: uses it directly, does not call git detection', async () => {
      mockListEnvironmentsPaginated.mockResolvedValue({
        pageInfo: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false },
        environments: [],
      });

      await searchEnvironmentsHandler({ projectUuid: PROJECT_UUID }, ctx);
      expect(mockDetectRepoName).not.toHaveBeenCalled();
      expect(mockFindProjectByRepoName).not.toHaveBeenCalled();
      expect(mockListEnvironmentsPaginated).toHaveBeenCalledWith(
        PROJECT_UUID, expect.any(Object), undefined,
      );
    });

    test('git fallback: resolves via findProjectByRepoName when projectUuid not given', async () => {
      mockDetectRepoName.mockReturnValue('debugg-ai/app');
      mockFindProjectByRepoName.mockResolvedValue(PROJECT);
      mockListEnvironmentsPaginated.mockResolvedValue({
        pageInfo: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false },
        environments: [],
      });

      await searchEnvironmentsHandler({}, ctx);
      expect(mockFindProjectByRepoName).toHaveBeenCalledWith('debugg-ai/app');
      expect(mockListEnvironmentsPaginated).toHaveBeenCalledWith(
        PROJECT_UUID, expect.any(Object), undefined,
      );
    });

    test('NoProjectResolved: no git + no projectUuid → error payload, environments empty', async () => {
      mockDetectRepoName.mockReturnValue(null);
      const res = await searchEnvironmentsHandler({}, ctx);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toBe('NoProjectResolved');
      expect(body.environments).toEqual([]);
    });

    test('NoProjectResolved: git detected but no matching project', async () => {
      mockDetectRepoName.mockReturnValue('random/repo');
      mockFindProjectByRepoName.mockResolvedValue(null);
      const res = await searchEnvironmentsHandler({}, ctx);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toBe('NoProjectResolved');
    });
  });

  describe('uuid mode (single env)', () => {
    test('returns single row with credentials expanded inline', async () => {
      mockGetEnvironment.mockResolvedValue(ENV_A);
      mockListCredentialsForEnvironment.mockResolvedValue(CREDS_A);

      const res = await searchEnvironmentsHandler({ projectUuid: PROJECT_UUID, uuid: ENV_UUID }, ctx);
      const body = JSON.parse(res.content[0].text!);

      expect(body.filter.uuid).toBe(ENV_UUID);
      expect(body.pageInfo.totalCount).toBe(1);
      expect(body.pageInfo.hasMore).toBe(false);
      expect(body.environments).toHaveLength(1);
      expect(body.environments[0].uuid).toBe(ENV_UUID);
      expect(body.environments[0].credentials).toHaveLength(2);
      expect(body.environments[0].credentials[0]).toMatchObject({
        uuid: 'c-a-1', label: 'admin', username: 'admin@x', role: 'admin',
      });
    });

    test('uuid miss: returns NotFound + isError:true', async () => {
      const err: any = new Error('404');
      err.statusCode = 404;
      mockGetEnvironment.mockRejectedValue(err);

      const res = await searchEnvironmentsHandler({ projectUuid: PROJECT_UUID, uuid: ENV_UUID }, ctx);
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toBe('NotFound');
      expect(body.uuid).toBe(ENV_UUID);
    });
  });

  describe('filter mode (list)', () => {
    test('returns paginated envs each with credentials inlined', async () => {
      mockListEnvironmentsPaginated.mockResolvedValue({
        pageInfo: { page: 1, pageSize: 20, totalCount: 2, totalPages: 1, hasMore: false },
        environments: [ENV_A, ENV_B],
      });
      mockListCredentialsForEnvironment
        .mockResolvedValueOnce(CREDS_A)
        .mockResolvedValueOnce(CREDS_B);

      const res = await searchEnvironmentsHandler({ projectUuid: PROJECT_UUID }, ctx);
      const body = JSON.parse(res.content[0].text!);

      expect(body.environments).toHaveLength(2);
      expect(body.environments[0].uuid).toBe(ENV_UUID);
      expect(body.environments[0].credentials).toHaveLength(2);
      expect(body.environments[1].uuid).toBe(ENV_UUID_2);
      expect(body.environments[1].credentials).toHaveLength(1);
    });

    test('q filter threaded through to service', async () => {
      mockListEnvironmentsPaginated.mockResolvedValue({
        pageInfo: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false },
        environments: [],
      });
      await searchEnvironmentsHandler({ projectUuid: PROJECT_UUID, q: 'stag' }, ctx);
      expect(mockListEnvironmentsPaginated).toHaveBeenCalledWith(
        PROJECT_UUID, expect.any(Object), 'stag',
      );
    });
  });

  describe('NO PASSWORD LEAK — invariant', () => {
    test('even if service accidentally returns a password field, handler response strips it', async () => {
      // Simulate buggy service leaking a password
      mockGetEnvironment.mockResolvedValue(ENV_A);
      mockListCredentialsForEnvironment.mockResolvedValue([
        { uuid: 'c1', label: 'a', username: 'u', role: 'admin', password: 'SECRET-IN-RESULT' },
      ] as any);

      const res = await searchEnvironmentsHandler(
        { projectUuid: PROJECT_UUID, uuid: ENV_UUID }, ctx,
      );
      const raw = res.content[0].text!;
      expect(raw).not.toContain('SECRET-IN-RESULT');
      expect(raw).not.toMatch(/"password"\s*:/);
    });

    test('password stripped from filter-mode responses too', async () => {
      mockListEnvironmentsPaginated.mockResolvedValue({
        pageInfo: { page: 1, pageSize: 20, totalCount: 1, totalPages: 1, hasMore: false },
        environments: [ENV_A],
      });
      mockListCredentialsForEnvironment.mockResolvedValue([
        { uuid: 'c', label: 'a', username: 'u', role: null, password: 'STAGE-PW-LEAK' },
      ] as any);

      const res = await searchEnvironmentsHandler({ projectUuid: PROJECT_UUID }, ctx);
      const raw = res.content[0].text!;
      expect(raw).not.toContain('STAGE-PW-LEAK');
      expect(raw).not.toMatch(/"password"\s*:/);
    });
  });
});
