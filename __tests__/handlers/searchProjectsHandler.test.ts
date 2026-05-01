/**
 * Tests for searchProjectsHandler — proof point for bead ue3.
 *
 * Mocks the service layer. Covers both uuid-lookup mode (single-row with full
 * project detail) and filter-mode (paginated summaries).
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockListProjects = jest.fn<(...args: any[]) => Promise<any>>();
const mockGetProject = jest.fn<(uuid: string) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    listProjects: mockListProjects,
    getProject: mockGetProject,
  })),
}));

let searchProjectsHandler: typeof import('../../handlers/searchProjectsHandler.js').searchProjectsHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/searchProjectsHandler.js');
  searchProjectsHandler = mod.searchProjectsHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };
const UUID = '8af227e9-3133-4b08-a7c8-25168a3aad25';

const FULL_PROJECT = {
  uuid: UUID,
  slug: '269532-debugg-ai-debugg-ai-mcp',
  name: 'debugg-ai/debugg-ai-mcp',
  platform: 'backend',
  description: '',
  repo: { uuid: 'repo-uuid', name: 'debugg-ai/debugg-ai-mcp', isGithubAuthorized: true },
  framework: 'express',
  language: 'typescript',
  // ...plus ~30 more keys in real backend
};

const SUMMARY_A = { uuid: 'p-a', slug: 'a', name: 'Project A', platform: 'web', repo: { name: 'org/a' } };
const SUMMARY_B = { uuid: 'p-b', slug: 'b', name: 'Project B', platform: 'web', repo: { name: 'org/b' } };

describe('searchProjectsHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('uuid mode', () => {
    test('uuid hit: returns single-row result with full project detail', async () => {
      mockGetProject.mockResolvedValue(FULL_PROJECT);

      const res = await searchProjectsHandler({ uuid: UUID }, ctx);
      const body = JSON.parse(res.content[0].text!);

      expect(mockGetProject).toHaveBeenCalledWith(UUID);
      expect(mockListProjects).not.toHaveBeenCalled();
      expect(body.filter).toEqual({ uuid: UUID });
      expect(body.pageInfo.totalCount).toBe(1);
      expect(body.pageInfo.totalPages).toBe(1);
      expect(body.pageInfo.hasMore).toBe(false);
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0].uuid).toBe(UUID);
      expect(body.projects[0].framework).toBe('express');  // full richness
    });

    test('uuid miss: returns isError:true NotFound', async () => {
      const err: any = new Error('404');
      err.statusCode = 404;
      mockGetProject.mockRejectedValue(err);

      const res = await searchProjectsHandler({ uuid: UUID }, ctx);
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toBe('NotFound');
      expect(body.uuid).toBe(UUID);
    });
  });

  describe('filter mode (no uuid)', () => {
    test('q filter: returns paginated summaries; summary shape only (not full richness)', async () => {
      mockListProjects.mockResolvedValue({
        pageInfo: { page: 1, pageSize: 20, totalCount: 2, totalPages: 1, hasMore: false },
        projects: [SUMMARY_A, SUMMARY_B],
      });

      const res = await searchProjectsHandler({ q: 'Project' }, ctx);
      const body = JSON.parse(res.content[0].text!);

      expect(mockListProjects).toHaveBeenCalled();
      expect(mockGetProject).not.toHaveBeenCalled();
      expect(body.filter).toEqual({ q: 'Project' });
      expect(body.pageInfo.totalCount).toBe(2);
      expect(body.projects).toHaveLength(2);
      // Summary shape: uuid, name, slug, repoName
      expect(body.projects[0]).toHaveProperty('uuid');
      expect(body.projects[0]).toHaveProperty('name');
      expect(body.projects[0]).toHaveProperty('slug');
      expect(body.projects[0]).toHaveProperty('repoName');
    });

    test('empty input: returns paginated summaries with default pagination', async () => {
      mockListProjects.mockResolvedValue({
        pageInfo: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false },
        projects: [],
      });

      const res = await searchProjectsHandler({}, ctx);
      const body = JSON.parse(res.content[0].text!);

      expect(body.projects).toEqual([]);
      expect(body.filter.q).toBeNull();
    });

    test('pagination threaded through: page + pageSize forwarded to service', async () => {
      mockListProjects.mockResolvedValue({
        pageInfo: { page: 2, pageSize: 5, totalCount: 20, totalPages: 4, hasMore: true },
        projects: [],
      });

      await searchProjectsHandler({ q: 'x', page: 2, pageSize: 5 }, ctx);
      const call = mockListProjects.mock.calls[0];
      // service signature: listProjects(pagination, q)
      expect(call[0]).toMatchObject({ page: 2, pageSize: 5 });
      expect(call[1]).toBe('x');
    });
  });
});
