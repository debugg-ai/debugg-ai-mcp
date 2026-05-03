import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockListTestSuites = jest.fn<(...args: any[]) => Promise<any>>();
const mockListProjects = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    listTestSuites: mockListTestSuites,
    listProjects: mockListProjects,
  })),
}));

let searchTestSuitesHandler: typeof import('../../handlers/searchTestSuitesHandler.js').searchTestSuitesHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/searchTestSuitesHandler.js');
  searchTestSuitesHandler = mod.searchTestSuitesHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };

const PROJECT_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROJECT = { uuid: PROJECT_UUID, name: 'My App' };

const SUITES = [
  { uuid: 'suite-1', name: 'Smoke Tests', description: 'Basic', runStatus: 'COMPLETED', testsCount: 3, passRate: 1.0, lastRunAt: '2026-05-01T00:00:00Z' },
  { uuid: 'suite-2', name: 'Auth Tests', description: 'Auth flows', runStatus: 'NEVER_RUN', testsCount: 5, passRate: null, lastRunAt: null },
];

const PAGE_INFO = { page: 1, pageSize: 20, totalCount: 2, totalPages: 1, hasMore: false };

describe('searchTestSuitesHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
  });

  describe('uuid mode', () => {
    test('projectUuid: passes directly to listTestSuites without lookup', async () => {
      mockListTestSuites.mockResolvedValue({ pageInfo: PAGE_INFO, suites: SUITES });

      const res = await searchTestSuitesHandler({ projectUuid: PROJECT_UUID }, ctx);

      expect(mockListProjects).not.toHaveBeenCalled();
      expect(mockListTestSuites).toHaveBeenCalledWith(
        expect.objectContaining({ projectUuid: PROJECT_UUID }),
      );
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.suites).toHaveLength(2);
      expect(body.pageInfo).toBeDefined();
    });

    test('returns pagination info in response', async () => {
      mockListTestSuites.mockResolvedValue({ pageInfo: PAGE_INFO, suites: SUITES });

      const res = await searchTestSuitesHandler({ projectUuid: PROJECT_UUID }, ctx);

      const body = JSON.parse(res.content[0].text!);
      expect(body.pageInfo.totalCount).toBe(2);
      expect(body.pageInfo.hasMore).toBe(false);
    });
  });

  describe('name resolution', () => {
    test('projectName resolved before search', async () => {
      mockListProjects.mockResolvedValue({ pageInfo: {}, projects: [PROJECT] });
      mockListTestSuites.mockResolvedValue({ pageInfo: PAGE_INFO, suites: SUITES });

      const res = await searchTestSuitesHandler({ projectName: 'My App' }, ctx);

      expect(mockListProjects).toHaveBeenCalled();
      expect(mockListTestSuites).toHaveBeenCalledWith(
        expect.objectContaining({ projectUuid: PROJECT_UUID }),
      );
      expect(res.isError).not.toBe(true);
    });
  });

  describe('filtering', () => {
    test('search query forwarded to listTestSuites', async () => {
      mockListTestSuites.mockResolvedValue({ pageInfo: PAGE_INFO, suites: [SUITES[0]] });

      await searchTestSuitesHandler({ projectUuid: PROJECT_UUID, search: 'smoke' }, ctx);

      expect(mockListTestSuites).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'smoke' }),
      );
    });

    test('pagination params forwarded when provided', async () => {
      mockListTestSuites.mockResolvedValue({ pageInfo: { page: 2, pageSize: 10, totalCount: 25, totalPages: 3, hasMore: true }, suites: SUITES });

      const res = await searchTestSuitesHandler({ projectUuid: PROJECT_UUID, page: 2, pageSize: 10 }, ctx);

      expect(mockListTestSuites).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, pageSize: 10 }),
      );
      const body = JSON.parse(res.content[0].text!);
      expect(body.pageInfo.hasMore).toBe(true);
    });

    test('empty results returns empty suites array not error', async () => {
      mockListTestSuites.mockResolvedValue({ pageInfo: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false }, suites: [] });

      const res = await searchTestSuitesHandler({ projectUuid: PROJECT_UUID }, ctx);

      expect(res.isError).not.toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.suites).toHaveLength(0);
      expect(body.pageInfo.totalCount).toBe(0);
    });
  });

  describe('error paths', () => {
    test('projectName not found: isError:true', async () => {
      mockListProjects.mockResolvedValue({ pageInfo: {}, projects: [] });

      const res = await searchTestSuitesHandler({ projectName: 'ghost' }, ctx);

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toMatch(/NotFound/i);
    });
  });
});
