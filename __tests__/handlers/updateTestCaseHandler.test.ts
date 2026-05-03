import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockUpdateTestCase = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    updateTestCase: mockUpdateTestCase,
  })),
}));

let updateTestCaseHandler: typeof import('../../handlers/updateTestCaseHandler.js').updateTestCaseHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/updateTestCaseHandler.js');
  updateTestCaseHandler = mod.updateTestCaseHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };
const TEST_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('updateTestCaseHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockUpdateTestCase.mockResolvedValue({ uuid: TEST_UUID, name: 'Updated', description: 'Updated desc' });
  });

  test('name update: calls updateTestCase with testUuid and name', async () => {
    const res = await updateTestCaseHandler(
      { testUuid: TEST_UUID, name: 'Updated' },
      ctx,
    );

    expect(mockUpdateTestCase).toHaveBeenCalledWith(
      TEST_UUID,
      expect.objectContaining({ name: 'Updated' }),
    );
    expect(res.isError).not.toBe(true);
    const body = JSON.parse(res.content[0].text!);
    expect(body.uuid).toBe(TEST_UUID);
  });

  test('description update only', async () => {
    await updateTestCaseHandler(
      { testUuid: TEST_UUID, description: 'New description' },
      ctx,
    );

    expect(mockUpdateTestCase).toHaveBeenCalledWith(
      TEST_UUID,
      expect.objectContaining({ description: 'New description' }),
    );
  });

  test('agentTaskDescription update only', async () => {
    await updateTestCaseHandler(
      { testUuid: TEST_UUID, agentTaskDescription: 'New task' },
      ctx,
    );

    expect(mockUpdateTestCase).toHaveBeenCalledWith(
      TEST_UUID,
      expect.objectContaining({ agentTaskDescription: 'New task' }),
    );
  });

  test('multiple fields updated together', async () => {
    await updateTestCaseHandler(
      { testUuid: TEST_UUID, name: 'New name', description: 'New desc', agentTaskDescription: 'New task' },
      ctx,
    );

    expect(mockUpdateTestCase).toHaveBeenCalledWith(
      TEST_UUID,
      expect.objectContaining({ name: 'New name', description: 'New desc', agentTaskDescription: 'New task' }),
    );
  });

  test('suite field is NOT forwarded even if somehow passed', async () => {
    await updateTestCaseHandler(
      { testUuid: TEST_UUID, name: 'New name' } as any,
      ctx,
    );

    const callArg = mockUpdateTestCase.mock.calls[0]?.[1] as any;
    expect(callArg).not.toHaveProperty('suite');
    expect(callArg).not.toHaveProperty('suiteUuid');
  });

  test('service error propagates as thrown MCPError', async () => {
    mockUpdateTestCase.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));

    await expect(
      updateTestCaseHandler({ testUuid: TEST_UUID, name: 'x' }, ctx),
    ).rejects.toThrow();
  });
});
