import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockGetTestSuiteDetail = jest.fn<(...args: any[]) => Promise<any>>();
const mockListTestSuites = jest.fn<(...args: any[]) => Promise<any>>();
const mockListProjects = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    getTestSuiteDetail: mockGetTestSuiteDetail,
    listTestSuites: mockListTestSuites,
    listProjects: mockListProjects,
  })),
}));

let getTestSuiteResultsHandler: typeof import('../../handlers/getTestSuiteResultsHandler.js').getTestSuiteResultsHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/getTestSuiteResultsHandler.js');
  getTestSuiteResultsHandler = mod.getTestSuiteResultsHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };

const PROJECT_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SUITE_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const SUITE_DETAIL = {
  uuid: SUITE_UUID,
  name: 'Smoke Tests',
  runStatus: 'COMPLETED',
  testsCount: 2,
  passRate: 0.5,
  lastRunAt: '2026-05-01T10:00:00Z',
  tests: [
    {
      uuid: 'test-1',
      name: 'Login test',
      runCount: 3,
      passedRunsCount: 2,
      failedRunsCount: 1,
      passRate: 0.67,
      lastRun: { uuid: 'run-1', status: 'COMPLETED', outcome: 'PASS', executionTime: 12.5, timestamp: '2026-05-01T10:00:00Z' },
    },
    {
      uuid: 'test-2',
      name: 'Checkout test',
      runCount: 1,
      passedRunsCount: 0,
      failedRunsCount: 1,
      passRate: 0.0,
      lastRun: { uuid: 'run-2', status: 'COMPLETED', outcome: 'FAIL', executionTime: 8.2, timestamp: '2026-05-01T10:01:00Z' },
    },
  ],
};

describe('getTestSuiteResultsHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockGetTestSuiteDetail.mockResolvedValue(SUITE_DETAIL);
  });

  describe('uuid mode', () => {
    test('suiteUuid: calls getTestSuiteDetail directly', async () => {
      const res = await getTestSuiteResultsHandler({ suiteUuid: SUITE_UUID }, ctx);

      expect(mockListTestSuites).not.toHaveBeenCalled();
      expect(mockGetTestSuiteDetail).toHaveBeenCalledWith(SUITE_UUID);
      expect(res.isError).not.toBe(true);
    });

    test('response includes suite-level fields', async () => {
      const res = await getTestSuiteResultsHandler({ suiteUuid: SUITE_UUID }, ctx);

      const body = JSON.parse(res.content[0].text!);
      expect(body.uuid).toBe(SUITE_UUID);
      expect(body.runStatus).toBe('COMPLETED');
      expect(body.testsCount).toBe(2);
      expect(body.passRate).toBe(0.5);
      expect(body.lastRunAt).toBeDefined();
    });

    test('response includes per-test results array', async () => {
      const res = await getTestSuiteResultsHandler({ suiteUuid: SUITE_UUID }, ctx);

      const body = JSON.parse(res.content[0].text!);
      expect(Array.isArray(body.tests)).toBe(true);
      expect(body.tests).toHaveLength(2);
    });

    test('each test result includes lastRun with outcome', async () => {
      const res = await getTestSuiteResultsHandler({ suiteUuid: SUITE_UUID }, ctx);

      const body = JSON.parse(res.content[0].text!);
      const firstTest = body.tests[0];
      expect(firstTest.uuid).toBeDefined();
      expect(firstTest.name).toBeDefined();
      expect(firstTest.lastRun).toBeDefined();
      expect(firstTest.lastRun.outcome).toBe('PASS');
    });

    test('pass/fail outcomes present for each test', async () => {
      const res = await getTestSuiteResultsHandler({ suiteUuid: SUITE_UUID }, ctx);

      const body = JSON.parse(res.content[0].text!);
      const outcomes = body.tests.map((t: any) => t.lastRun?.outcome);
      expect(outcomes).toContain('PASS');
      expect(outcomes).toContain('FAIL');
    });
  });

  describe('suite with no runs', () => {
    test('NEVER_RUN suite: returns suite with empty/null run data', async () => {
      mockGetTestSuiteDetail.mockResolvedValue({
        uuid: SUITE_UUID,
        name: 'New Suite',
        runStatus: 'NEVER_RUN',
        testsCount: 1,
        passRate: null,
        lastRunAt: null,
        tests: [{ uuid: 'test-1', name: 'Test', runCount: 0, passedRunsCount: 0, failedRunsCount: 0, passRate: null, lastRun: null }],
      });

      const res = await getTestSuiteResultsHandler({ suiteUuid: SUITE_UUID }, ctx);

      expect(res.isError).not.toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.runStatus).toBe('NEVER_RUN');
      expect(body.tests[0].lastRun).toBeNull();
    });
  });

  describe('name resolution', () => {
    test('suiteName + projectUuid: resolves suite then fetches detail', async () => {
      mockListTestSuites.mockResolvedValue({
        pageInfo: {},
        suites: [{ uuid: SUITE_UUID, name: 'Smoke Tests' }],
      });

      const res = await getTestSuiteResultsHandler(
        { suiteName: 'Smoke Tests', projectUuid: PROJECT_UUID },
        ctx,
      );

      expect(mockListTestSuites).toHaveBeenCalled();
      expect(mockGetTestSuiteDetail).toHaveBeenCalledWith(SUITE_UUID);
      expect(res.isError).not.toBe(true);
    });
  });

  describe('error paths', () => {
    test('suiteName not found: isError:true', async () => {
      mockListTestSuites.mockResolvedValue({ pageInfo: {}, suites: [] });

      const res = await getTestSuiteResultsHandler(
        { suiteName: 'ghost', projectUuid: PROJECT_UUID },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(mockGetTestSuiteDetail).not.toHaveBeenCalled();
    });

    test('backend 404: throws MCPError', async () => {
      mockGetTestSuiteDetail.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));

      await expect(
        getTestSuiteResultsHandler({ suiteUuid: SUITE_UUID }, ctx),
      ).rejects.toThrow();
    });
  });
});
