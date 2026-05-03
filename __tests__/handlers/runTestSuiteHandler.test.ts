import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockRunTestSuite = jest.fn<(...args: any[]) => Promise<any>>();
const mockListTestSuites = jest.fn<(...args: any[]) => Promise<any>>();
const mockListProjects = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    runTestSuite: mockRunTestSuite,
    listTestSuites: mockListTestSuites,
    listProjects: mockListProjects,
  })),
}));

let runTestSuiteHandler: typeof import('../../handlers/runTestSuiteHandler.js').runTestSuiteHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/runTestSuiteHandler.js');
  runTestSuiteHandler = mod.runTestSuiteHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };

const PROJECT_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SUITE_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RUN_RESPONSE = { suiteUuid: SUITE_UUID, runStatus: 'PENDING', testsTriggered: 3 };

describe('runTestSuiteHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockRunTestSuite.mockResolvedValue(RUN_RESPONSE);
  });

  describe('uuid mode', () => {
    test('suiteUuid: calls runTestSuite directly', async () => {
      const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID }, ctx);

      expect(mockListTestSuites).not.toHaveBeenCalled();
      expect(mockRunTestSuite).toHaveBeenCalledWith(SUITE_UUID, expect.any(Object));
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.suiteUuid).toBe(SUITE_UUID);
      expect(body.runStatus).toBe('PENDING');
      expect(body.testsTriggered).toBe(3);
    });

    test('targetUrl forwarded when provided', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'https://staging.example.com' }, ctx);

      expect(mockRunTestSuite).toHaveBeenCalledWith(
        SUITE_UUID,
        expect.objectContaining({ targetUrl: 'https://staging.example.com' }),
      );
    });

    test('targetUrl omitted when not provided', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID }, ctx);

      const callArg = mockRunTestSuite.mock.calls[0]?.[1] as any;
      expect(callArg?.targetUrl).toBeUndefined();
    });
  });

  describe('name resolution', () => {
    test('suiteName + projectUuid: resolves suite then runs', async () => {
      mockListTestSuites.mockResolvedValue({
        pageInfo: {},
        suites: [{ uuid: SUITE_UUID, name: 'Smoke Tests' }],
      });

      const res = await runTestSuiteHandler(
        { suiteName: 'Smoke Tests', projectUuid: PROJECT_UUID },
        ctx,
      );

      expect(mockListTestSuites).toHaveBeenCalled();
      expect(mockRunTestSuite).toHaveBeenCalledWith(SUITE_UUID, expect.any(Object));
      expect(res.isError).not.toBe(true);
    });

    test('suiteName + projectName: resolves both then runs', async () => {
      mockListProjects.mockResolvedValue({ pageInfo: {}, projects: [{ uuid: PROJECT_UUID, name: 'My App' }] });
      mockListTestSuites.mockResolvedValue({ pageInfo: {}, suites: [{ uuid: SUITE_UUID, name: 'Smoke Tests' }] });

      const res = await runTestSuiteHandler(
        { suiteName: 'Smoke Tests', projectName: 'My App' },
        ctx,
      );

      expect(mockRunTestSuite).toHaveBeenCalledWith(SUITE_UUID, expect.any(Object));
      expect(res.isError).not.toBe(true);
    });
  });

  describe('response', () => {
    test('response includes async note (runs are not synchronous)', async () => {
      const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID }, ctx);

      const body = JSON.parse(res.content[0].text!);
      expect(body.runStatus).toBeDefined();
      expect(['PENDING', 'RUNNING']).toContain(body.runStatus);
    });
  });

  describe('error paths', () => {
    test('suiteName not found: isError:true', async () => {
      mockListTestSuites.mockResolvedValue({ pageInfo: {}, suites: [] });

      const res = await runTestSuiteHandler(
        { suiteName: 'ghost', projectUuid: PROJECT_UUID },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(mockRunTestSuite).not.toHaveBeenCalled();
    });
  });
});
