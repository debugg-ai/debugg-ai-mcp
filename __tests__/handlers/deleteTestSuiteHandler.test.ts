import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockDisableTestSuite = jest.fn<(...args: any[]) => Promise<any>>();
const mockListTestSuites = jest.fn<(...args: any[]) => Promise<any>>();
const mockListProjects = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    disableTestSuite: mockDisableTestSuite,
    listTestSuites: mockListTestSuites,
    listProjects: mockListProjects,
  })),
}));

let deleteTestSuiteHandler: typeof import('../../handlers/deleteTestSuiteHandler.js').deleteTestSuiteHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/deleteTestSuiteHandler.js');
  deleteTestSuiteHandler = mod.deleteTestSuiteHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };

const PROJECT_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SUITE_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('deleteTestSuiteHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockDisableTestSuite.mockResolvedValue({ uuid: SUITE_UUID, isDisabled: true });
  });

  describe('uuid mode', () => {
    test('suiteUuid provided: calls disableTestSuite directly', async () => {
      const res = await deleteTestSuiteHandler({ suiteUuid: SUITE_UUID }, ctx);

      expect(mockListTestSuites).not.toHaveBeenCalled();
      expect(mockDisableTestSuite).toHaveBeenCalledWith(SUITE_UUID);
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.deleted).toBe(true);
      expect(body.suiteUuid).toBe(SUITE_UUID);
    });
  });

  describe('name resolution', () => {
    test('suiteName + projectUuid: resolves suite then disables', async () => {
      mockListTestSuites.mockResolvedValue({
        pageInfo: {},
        suites: [{ uuid: SUITE_UUID, name: 'Smoke Tests' }],
      });

      const res = await deleteTestSuiteHandler(
        { suiteName: 'Smoke Tests', projectUuid: PROJECT_UUID },
        ctx,
      );

      expect(mockListTestSuites).toHaveBeenCalledWith(
        expect.objectContaining({ projectUuid: PROJECT_UUID }),
      );
      expect(mockDisableTestSuite).toHaveBeenCalledWith(SUITE_UUID);
      expect(res.isError).not.toBe(true);
    });

    test('suiteName + projectName: resolves project then suite', async () => {
      mockListProjects.mockResolvedValue({ pageInfo: {}, projects: [{ uuid: PROJECT_UUID, name: 'My App' }] });
      mockListTestSuites.mockResolvedValue({
        pageInfo: {},
        suites: [{ uuid: SUITE_UUID, name: 'Smoke Tests' }],
      });

      const res = await deleteTestSuiteHandler(
        { suiteName: 'Smoke Tests', projectName: 'My App' },
        ctx,
      );

      expect(mockListProjects).toHaveBeenCalled();
      expect(mockDisableTestSuite).toHaveBeenCalledWith(SUITE_UUID);
      expect(res.isError).not.toBe(true);
    });
  });

  describe('error paths', () => {
    test('suiteName not found: isError:true', async () => {
      mockListTestSuites.mockResolvedValue({ pageInfo: {}, suites: [] });

      const res = await deleteTestSuiteHandler(
        { suiteName: 'ghost', projectUuid: PROJECT_UUID },
        ctx,
      );

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toMatch(/NotFound/i);
      expect(mockDisableTestSuite).not.toHaveBeenCalled();
    });

    test('suiteName ambiguous: isError:true with candidates', async () => {
      mockListTestSuites.mockResolvedValue({
        pageInfo: {},
        suites: [
          { uuid: 'x', name: 'Smoke Tests' },
          { uuid: 'y', name: 'smoke tests' },
        ],
      });

      const res = await deleteTestSuiteHandler(
        { suiteName: 'Smoke Tests', projectUuid: PROJECT_UUID },
        ctx,
      );

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toMatch(/Ambiguous/i);
      expect(body.candidates).toBeDefined();
      expect(mockDisableTestSuite).not.toHaveBeenCalled();
    });
  });
});
