import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockCreateTestSuite = jest.fn<(...args: any[]) => Promise<any>>();
const mockListProjects = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    createTestSuite: mockCreateTestSuite,
    listProjects: mockListProjects,
  })),
}));

let createTestSuiteHandler: typeof import('../../handlers/createTestSuiteHandler.js').createTestSuiteHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/createTestSuiteHandler.js');
  createTestSuiteHandler = mod.createTestSuiteHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };

const PROJECT_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SUITE_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PROJECT = { uuid: PROJECT_UUID, name: 'My App' };
const SUITE = { uuid: SUITE_UUID, name: 'Smoke Tests', description: 'Basic smoke tests', runStatus: 'NEVER_RUN', testsCount: 0 };

describe('createTestSuiteHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
  });

  describe('uuid mode', () => {
    test('projectUuid provided: skips project lookup and calls createTestSuite', async () => {
      mockCreateTestSuite.mockResolvedValue(SUITE);

      const res = await createTestSuiteHandler(
        { name: 'Smoke Tests', description: 'Basic smoke tests', projectUuid: PROJECT_UUID },
        ctx,
      );

      expect(mockListProjects).not.toHaveBeenCalled();
      expect(mockCreateTestSuite).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Smoke Tests', description: 'Basic smoke tests', projectUuid: PROJECT_UUID }),
      );
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.uuid).toBe(SUITE_UUID);
    });
  });

  describe('name resolution', () => {
    test('projectName resolved to uuid before calling createTestSuite', async () => {
      mockListProjects.mockResolvedValue({ pageInfo: {}, projects: [PROJECT] });
      mockCreateTestSuite.mockResolvedValue(SUITE);

      const res = await createTestSuiteHandler(
        { name: 'Smoke Tests', description: 'Basic smoke tests', projectName: 'My App' },
        ctx,
      );

      expect(mockListProjects).toHaveBeenCalled();
      expect(mockCreateTestSuite).toHaveBeenCalledWith(
        expect.objectContaining({ projectUuid: PROJECT_UUID }),
      );
      expect(res.isError).not.toBe(true);
    });

    test('projectName is case-insensitive', async () => {
      mockListProjects.mockResolvedValue({ pageInfo: {}, projects: [PROJECT] });
      mockCreateTestSuite.mockResolvedValue(SUITE);

      const res = await createTestSuiteHandler(
        { name: 'Smoke Tests', description: 'desc', projectName: 'MY APP' },
        ctx,
      );

      expect(res.isError).not.toBe(true);
      expect(mockCreateTestSuite).toHaveBeenCalledWith(
        expect.objectContaining({ projectUuid: PROJECT_UUID }),
      );
    });
  });

  describe('error paths', () => {
    test('projectName not found: isError:true with NotFound', async () => {
      mockListProjects.mockResolvedValue({ pageInfo: {}, projects: [] });

      const res = await createTestSuiteHandler(
        { name: 'Smoke Tests', description: 'desc', projectName: 'ghost' },
        ctx,
      );

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toMatch(/NotFound/i);
      expect(mockCreateTestSuite).not.toHaveBeenCalled();
    });

    test('projectName ambiguous: isError:true with candidates', async () => {
      mockListProjects.mockResolvedValue({
        pageInfo: {},
        projects: [
          { uuid: 'x', name: 'My App' },
          { uuid: 'y', name: 'my app' },
        ],
      });

      const res = await createTestSuiteHandler(
        { name: 'Smoke Tests', description: 'desc', projectName: 'My App' },
        ctx,
      );

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toMatch(/Ambiguous/i);
      expect(body.candidates).toBeDefined();
      expect(mockCreateTestSuite).not.toHaveBeenCalled();
    });
  });
});
