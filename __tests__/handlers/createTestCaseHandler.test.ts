import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockCreateTestCase = jest.fn<(...args: any[]) => Promise<any>>();
const mockListTestSuites = jest.fn<(...args: any[]) => Promise<any>>();
const mockListProjects = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    createTestCase: mockCreateTestCase,
    listTestSuites: mockListTestSuites,
    listProjects: mockListProjects,
  })),
}));

let createTestCaseHandler: typeof import('../../handlers/createTestCaseHandler.js').createTestCaseHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/createTestCaseHandler.js');
  createTestCaseHandler = mod.createTestCaseHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };

const PROJECT_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SUITE_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TEST_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TEST_CASE = { uuid: TEST_UUID, name: 'Login test', description: 'Tests login flow', agentTaskDescription: 'Log in with valid creds', suite: SUITE_UUID, runCount: 0 };

describe('createTestCaseHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockCreateTestCase.mockResolvedValue(TEST_CASE);
  });

  describe('uuid mode', () => {
    test('suiteUuid + projectUuid: no lookups, run=false passed to service', async () => {
      const res = await createTestCaseHandler(
        {
          name: 'Login test',
          description: 'Tests login flow',
          agentTaskDescription: 'Log in with valid creds',
          suiteUuid: SUITE_UUID,
          projectUuid: PROJECT_UUID,
        },
        ctx,
      );

      expect(mockListTestSuites).not.toHaveBeenCalled();
      expect(mockListProjects).not.toHaveBeenCalled();
      expect(mockCreateTestCase).toHaveBeenCalledWith(
        expect.objectContaining({
          suiteUuid: SUITE_UUID,
          projectUuid: PROJECT_UUID,
        }),
      );
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.uuid).toBe(TEST_UUID);
    });
  });

  describe('name resolution', () => {
    test('suiteName + projectUuid: resolves suite uuid', async () => {
      mockListTestSuites.mockResolvedValue({
        pageInfo: {},
        suites: [{ uuid: SUITE_UUID, name: 'Smoke Tests' }],
      });

      const res = await createTestCaseHandler(
        {
          name: 'Login test',
          description: 'desc',
          agentTaskDescription: 'task',
          suiteName: 'Smoke Tests',
          projectUuid: PROJECT_UUID,
        },
        ctx,
      );

      expect(mockListTestSuites).toHaveBeenCalled();
      expect(mockCreateTestCase).toHaveBeenCalledWith(
        expect.objectContaining({ suiteUuid: SUITE_UUID }),
      );
      expect(res.isError).not.toBe(true);
    });

    test('suiteName + projectName: resolves project then suite', async () => {
      mockListProjects.mockResolvedValue({ pageInfo: {}, projects: [{ uuid: PROJECT_UUID, name: 'My App' }] });
      mockListTestSuites.mockResolvedValue({ pageInfo: {}, suites: [{ uuid: SUITE_UUID, name: 'Smoke Tests' }] });

      const res = await createTestCaseHandler(
        {
          name: 'Login test',
          description: 'desc',
          agentTaskDescription: 'task',
          suiteName: 'Smoke Tests',
          projectName: 'My App',
        },
        ctx,
      );

      expect(mockListProjects).toHaveBeenCalled();
      expect(mockListTestSuites).toHaveBeenCalled();
      expect(mockCreateTestCase).toHaveBeenCalledWith(
        expect.objectContaining({ projectUuid: PROJECT_UUID, suiteUuid: SUITE_UUID }),
      );
      expect(res.isError).not.toBe(true);
    });
  });

  describe('optional fields', () => {
    test('relativeUrl forwarded when provided', async () => {
      await createTestCaseHandler(
        {
          name: 'Login test',
          description: 'desc',
          agentTaskDescription: 'task',
          suiteUuid: SUITE_UUID,
          projectUuid: PROJECT_UUID,
          relativeUrl: '/login',
        },
        ctx,
      );

      expect(mockCreateTestCase).toHaveBeenCalledWith(
        expect.objectContaining({ relativeUrl: '/login' }),
      );
    });

    test('maxSteps forwarded when provided', async () => {
      await createTestCaseHandler(
        {
          name: 'Login test',
          description: 'desc',
          agentTaskDescription: 'task',
          suiteUuid: SUITE_UUID,
          projectUuid: PROJECT_UUID,
          maxSteps: 50,
        },
        ctx,
      );

      expect(mockCreateTestCase).toHaveBeenCalledWith(
        expect.objectContaining({ maxSteps: 50 }),
      );
    });
  });

  describe('error paths', () => {
    test('suiteName not found: isError:true', async () => {
      mockListTestSuites.mockResolvedValue({ pageInfo: {}, suites: [] });

      const res = await createTestCaseHandler(
        {
          name: 'Login test',
          description: 'desc',
          agentTaskDescription: 'task',
          suiteName: 'ghost',
          projectUuid: PROJECT_UUID,
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toMatch(/NotFound/i);
      expect(mockCreateTestCase).not.toHaveBeenCalled();
    });
  });
});
