/**
 * searchExecutionsHandler unit tests — proof point for bead 49b.
 *
 * Mirrors the uuid-vs-filter pattern established by search_projects /
 * search_environments. Uuid mode returns full detail (nodeExecutions, state,
 * etc.); filter mode returns summaries.
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockGetExecution = jest.fn<(uuid: string) => Promise<any>>();
const mockListExecutions = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    workflows: {
      getExecution: mockGetExecution,
      listExecutions: mockListExecutions,
    },
  })),
}));

let searchExecutionsHandler: typeof import('../../handlers/searchExecutionsHandler.js').searchExecutionsHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/searchExecutionsHandler.js');
  searchExecutionsHandler = mod.searchExecutionsHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };
const UUID = '11111111-1111-1111-1111-111111111111';

const EXEC_DETAIL = {
  uuid: UUID,
  status: 'completed',
  startedAt: '2026-04-22T10:00:00Z',
  completedAt: '2026-04-22T10:05:00Z',
  durationMs: 300000,
  state: { outcome: 'pass', success: true, stepsTaken: 3 },
  errorMessage: '',
  errorInfo: null,
  nodeExecutions: [
    { nodeId: 'n1', nodeType: 'trigger.event', status: 'success', executionOrder: 1 },
    { nodeId: 'n2', nodeType: 'browser.setup', status: 'success', executionOrder: 2 },
  ],
};

const SUMMARY_A = { uuid: 'e-a', status: 'completed', startedAt: 't1', completedAt: 't2', durationMs: 1000, outcome: 'pass' };
const SUMMARY_B = { uuid: 'e-b', status: 'running', startedAt: 't3', completedAt: null, durationMs: null, outcome: null };

describe('searchExecutionsHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
  });

  describe('uuid mode', () => {
    test('returns single-row with full detail (nodeExecutions, state)', async () => {
      mockGetExecution.mockResolvedValue(EXEC_DETAIL);
      const res = await searchExecutionsHandler({ uuid: UUID }, ctx);
      const body = JSON.parse(res.content[0].text!);

      expect(mockGetExecution).toHaveBeenCalledWith(UUID);
      expect(mockListExecutions).not.toHaveBeenCalled();
      expect(body.filter).toEqual({ uuid: UUID });
      expect(body.pageInfo.totalCount).toBe(1);
      expect(body.executions).toHaveLength(1);
      expect(body.executions[0].uuid).toBe(UUID);
      expect(body.executions[0].nodeExecutions).toHaveLength(2);
      expect(body.executions[0].state).toMatchObject({ outcome: 'pass', success: true });
    });

    test('uuid miss: isError:true NotFound', async () => {
      const err: any = new Error('404');
      err.statusCode = 404;
      mockGetExecution.mockRejectedValue(err);
      const res = await searchExecutionsHandler({ uuid: UUID }, ctx);
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toBe('NotFound');
      expect(body.uuid).toBe(UUID);
    });
  });

  describe('filter mode', () => {
    test('status + projectUuid forwarded to service; summaries returned', async () => {
      mockListExecutions.mockResolvedValue({
        pageInfo: { page: 1, pageSize: 20, totalCount: 2, totalPages: 1, hasMore: false },
        executions: [SUMMARY_A, SUMMARY_B],
      });
      const res = await searchExecutionsHandler({
        status: 'completed',
        projectUuid: '00000000-0000-0000-0000-000000000abc',
        page: 2,
        pageSize: 5,
      }, ctx);
      const body = JSON.parse(res.content[0].text!);

      const call = mockListExecutions.mock.calls[0][0];
      expect(call.status).toBe('completed');
      expect(call.projectId).toBe('00000000-0000-0000-0000-000000000abc'); // service contract uses projectId
      expect(call.page).toBe(2);
      expect(call.pageSize).toBe(5);
      expect(body.executions).toHaveLength(2);
      expect(body.filter).toMatchObject({
        status: 'completed',
        projectUuid: '00000000-0000-0000-0000-000000000abc',
      });
    });

    test('empty input: default pagination, no filters', async () => {
      mockListExecutions.mockResolvedValue({
        pageInfo: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false },
        executions: [],
      });
      const res = await searchExecutionsHandler({}, ctx);
      const body = JSON.parse(res.content[0].text!);
      expect(body.executions).toEqual([]);
      expect(body.filter.status).toBeNull();
      expect(body.filter.projectUuid).toBeNull();
    });
  });
});
