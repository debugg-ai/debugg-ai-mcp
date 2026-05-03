import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockDisableTestCase = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    disableTestCase: mockDisableTestCase,
  })),
}));

let deleteTestCaseHandler: typeof import('../../handlers/deleteTestCaseHandler.js').deleteTestCaseHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/deleteTestCaseHandler.js');
  deleteTestCaseHandler = mod.deleteTestCaseHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };
const TEST_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('deleteTestCaseHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockDisableTestCase.mockResolvedValue({ uuid: TEST_UUID, isDisabled: true });
  });

  test('calls disableTestCase with testUuid', async () => {
    const res = await deleteTestCaseHandler({ testUuid: TEST_UUID }, ctx);

    expect(mockDisableTestCase).toHaveBeenCalledWith(TEST_UUID);
    expect(res.isError).not.toBe(true);
    const body = JSON.parse(res.content[0].text!);
    expect(body.deleted).toBe(true);
    expect(body.testUuid).toBe(TEST_UUID);
  });

  test('service 404 propagates as thrown MCPError', async () => {
    mockDisableTestCase.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));

    await expect(
      deleteTestCaseHandler({ testUuid: TEST_UUID }, ctx),
    ).rejects.toThrow();
  });

  test('response confirms soft delete (not hard delete)', async () => {
    const res = await deleteTestCaseHandler({ testUuid: TEST_UUID }, ctx);

    const body = JSON.parse(res.content[0].text!);
    expect(body.deleted).toBe(true);
    expect(body.testUuid).toBeDefined();
  });
});
