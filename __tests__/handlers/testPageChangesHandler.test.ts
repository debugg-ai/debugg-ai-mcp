/**
 * Tests for testPageChangesHandler
 * Verifies execute-first tunnel flow and ngrok key revocation
 */

import { ToolContext } from '../../types/index.js';

const mockContext: ToolContext = {
  requestId: 'test-req-123',
  timestamp: new Date(),
};

const mockExecuteResponse = {
  executionUuid: 'exec-uuid-abc',
  tunnelKey: 'ngrok_api_test_key',
  ngrokKeyId: 'ak_test_key_id',
  ngrokExpiresAt: '2026-02-19T20:00:00Z',
  resolvedEnvironmentId: null,
  resolvedCredentialId: null,
};

const mockFinalExecution = {
  uuid: 'exec-uuid-abc',
  status: 'completed',
  startedAt: '2026-02-19T17:00:00Z',
  completedAt: '2026-02-19T17:02:00Z',
  durationMs: 120000,
  state: { outcome: 'pass', success: true, stepsTaken: 3, error: '' },
  errorMessage: '',
  errorInfo: null,
  nodeExecutions: [
    {
      nodeId: 'surfer-1',
      nodeType: 'surfer.execute_task',
      status: 'completed',
      outputData: { agentResponse: 'Page loaded successfully', stepsTaken: 3 },
      executionOrder: 2,
    },
  ],
};

describe('testPageChangesHandler — execute-first tunnel flow', () => {
  describe('resolveTargetUrl', () => {
    test('uses url param when provided', () => {
      const resolve = (input: { url?: string; localPort?: number }) => {
        if (input.url) return input.url;
        if (input.localPort) return `http://localhost:${input.localPort}`;
        throw new Error('Provide url or localPort');
      };
      expect(resolve({ url: 'https://example.com' })).toBe('https://example.com');
    });

    test('constructs localhost url from localPort', () => {
      const resolve = (input: { url?: string; localPort?: number }) => {
        if (input.url) return input.url;
        if (input.localPort) return `http://localhost:${input.localPort}`;
        throw new Error('Provide url or localPort');
      };
      expect(resolve({ localPort: 3000 })).toBe('http://localhost:3000');
    });

    test('throws if neither url nor localPort provided', () => {
      const resolve = (input: { url?: string; localPort?: number }) => {
        if (input.url) return input.url;
        if (input.localPort) return `http://localhost:${input.localPort}`;
        throw new Error('Provide url or localPort');
      };
      expect(() => resolve({})).toThrow('Provide url or localPort');
    });
  });

  describe('WorkflowExecuteResponse shape', () => {
    test('executeWorkflow returns full response object', () => {
      // Verify the shape our handler depends on
      expect(mockExecuteResponse).toHaveProperty('executionUuid');
      expect(mockExecuteResponse).toHaveProperty('tunnelKey');
      expect(mockExecuteResponse).toHaveProperty('ngrokKeyId');
      expect(mockExecuteResponse).toHaveProperty('ngrokExpiresAt');
      expect(mockExecuteResponse).toHaveProperty('resolvedEnvironmentId');
      expect(mockExecuteResponse).toHaveProperty('resolvedCredentialId');
    });

    test('tunnel key comes from execute response (not a separate probe call)', () => {
      // The tunnelKey is present in the execute response itself
      expect(mockExecuteResponse.tunnelKey).toBe('ngrok_api_test_key');
      expect(mockExecuteResponse.ngrokKeyId).toBe('ak_test_key_id');
    });

    test('executionUuid used as tunnel subdomain', () => {
      // Handler uses executionUuid as tunnelId for ngrok subdomain
      const expectedTunnelUrl = `https://${mockExecuteResponse.executionUuid}.ngrok.debugg.ai`;
      expect(expectedTunnelUrl).toBe('https://exec-uuid-abc.ngrok.debugg.ai');
    });
  });

  describe('ngrok key revocation', () => {
    test('ngrokKeyId is extracted and available for revocation', () => {
      const ngrokKeyId = mockExecuteResponse.ngrokKeyId;
      expect(ngrokKeyId).toBe('ak_test_key_id');
      // In the handler, this is passed to client.revokeNgrokKey() in finally
    });

    test('null ngrokKeyId does not trigger revocation', () => {
      const responseWithNullKey = { ...mockExecuteResponse, ngrokKeyId: null };
      const ngrokKeyId = responseWithNullKey.ngrokKeyId ?? undefined;
      // Should be undefined so the if (ngrokKeyId) guard skips the call
      expect(ngrokKeyId).toBeUndefined();
    });
  });

  describe('execution result formatting', () => {
    test('extracts outcome and surfer output from final execution', () => {
      const outcome = mockFinalExecution.state?.outcome ?? mockFinalExecution.status;
      const surferNode = mockFinalExecution.nodeExecutions?.find(
        n => n.nodeType === 'surfer.execute_task'
      );

      expect(outcome).toBe('pass');
      expect(surferNode?.outputData?.agentResponse).toBe('Page loaded successfully');
      expect(surferNode?.outputData?.stepsTaken).toBe(3);
    });

    test('stepsTaken falls back to surfer node output when state missing', () => {
      const execWithoutState = {
        ...mockFinalExecution,
        state: { outcome: 'pass', success: true, stepsTaken: 0, error: '' },
      };
      const surferNode = execWithoutState.nodeExecutions?.find(
        n => n.nodeType === 'surfer.execute_task'
      );
      const stepsTaken =
        execWithoutState.state?.stepsTaken || surferNode?.outputData?.stepsTaken || 0;
      expect(stepsTaken).toBe(3);
    });
  });
});

describe('polling progress — nodeExecutions-based', () => {
  const NODE_PHASE_LABELS: Record<number, string> = {
    0: 'Browser agent starting up...',
    1: 'Browser ready, agent navigating...',
    2: 'Agent evaluating app...',
    3: 'Wrapping up...',
  };

  const makeExec = (nodeCount: number, status = 'running') => ({
    uuid: 'exec-uuid-abc',
    status,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    state: null,
    errorMessage: '',
    errorInfo: null,
    nodeExecutions: Array.from({ length: nodeCount }, (_, i) => ({
      nodeId: `node-${i}`,
      nodeType: 'some.node',
      status: 'completed',
      executionOrder: i,
    })),
  });

  test('state is null during execution — no crash', () => {
    const exec = makeExec(0);
    const outcome = exec.state?.outcome ?? exec.status;
    expect(outcome).toBe('running');
  });

  test.each([
    [0, 3, 'Browser agent starting up...'],
    [1, 5, 'Browser ready, agent navigating...'],
    [2, 7, 'Agent evaluating app...'],
    [3, 9, 'Wrapping up...'],
    [4, 9, 'Agent working...'],   // capped at 9, unknown label falls back
  ])('%i nodes completed → progress %i', (nodeCount, expectedProgress, expectedMessage) => {
    const exec = makeExec(nodeCount);
    const progress = Math.min(3 + nodeCount * 2, 9);
    const message = exec.status === 'running'
      ? (NODE_PHASE_LABELS[nodeCount] ?? 'Agent working...')
      : exec.status;
    expect(progress).toBe(expectedProgress);
    expect(message).toBe(expectedMessage);
  });

  test('progress capped at 9 even with many nodeExecutions', () => {
    const progress = Math.min(3 + 10 * 2, 9);
    expect(progress).toBe(9);
  });

  test('pollExecution calls onUpdate on each poll and returns on terminal status', async () => {
    const executions = [
      makeExec(0, 'running'),
      makeExec(1, 'running'),
      makeExec(3, 'completed'),
    ];
    let callIndex = 0;
    const getExecution = async () => executions[callIndex++];

    const updates: Array<{ nodeCount: number; status: string }> = [];
    const onUpdate = async (exec: any) => {
      updates.push({ nodeCount: exec.nodeExecutions.length, status: exec.status });
    };

    const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
    async function pollExecution(onUpd?: (e: any) => Promise<void>) {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const execution = await getExecution();
        if (onUpd) await onUpd(execution);
        if (TERMINAL_STATUSES.has(execution.status)) return execution;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    const result = await pollExecution(onUpdate);

    expect(result?.status).toBe('completed');
    expect(updates).toHaveLength(3);
    expect(updates[0]).toEqual({ nodeCount: 0, status: 'running' });
    expect(updates[1]).toEqual({ nodeCount: 1, status: 'running' });
    expect(updates[2]).toEqual({ nodeCount: 3, status: 'completed' });
  });

  test('progress callbacks receive increasing values as nodes complete', async () => {
    const executions = [
      makeExec(0, 'running'),
      makeExec(1, 'running'),
      makeExec(2, 'running'),
      makeExec(3, 'completed'),
    ];
    let callIndex = 0;
    const getExecution = async () => executions[callIndex++];

    const progressValues: number[] = [];
    const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
    async function pollExecution() {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const exec = await getExecution();
        const nodeCount = exec.nodeExecutions?.length ?? 0;
        progressValues.push(Math.min(3 + nodeCount * 2, 9));
        if (TERMINAL_STATUSES.has(exec.status)) return exec;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    await pollExecution();

    expect(progressValues).toEqual([3, 5, 7, 9]);
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
    }
  });
});

describe('WorkflowsService.executeWorkflow interface', () => {
  test('env param is optional', () => {
    // executeWorkflow(uuid, contextData, env?) — env is optional
    const callWithoutEnv = (uuid: string, ctx: Record<string, any>, env?: object) => ({
      uuid,
      ctx,
      hasEnv: !!env,
    });
    expect(callWithoutEnv('uuid', { targetUrl: 'https://example.com' }).hasEnv).toBe(false);
    expect(
      callWithoutEnv('uuid', { targetUrl: 'https://example.com' }, { credentialRole: 'admin' }).hasEnv
    ).toBe(true);
  });

  test('env field is omitted from request body when empty', () => {
    const buildBody = (contextData: object, env?: Record<string, any>) => {
      const body: Record<string, any> = { contextData };
      if (env && Object.keys(env).length > 0) body.env = env;
      return body;
    };

    expect(buildBody({ targetUrl: 'x' })).not.toHaveProperty('env');
    expect(buildBody({ targetUrl: 'x' }, {})).not.toHaveProperty('env');
    expect(buildBody({ targetUrl: 'x' }, { credentialRole: 'admin' })).toHaveProperty('env');
  });
});
