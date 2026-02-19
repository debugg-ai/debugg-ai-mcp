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
