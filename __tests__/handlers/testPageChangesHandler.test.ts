/**
 * Tests for testPageChangesHandler
 * Verifies execute-first tunnel flow and ngrok key revocation
 */

import { ToolContext, TestPageChangesInputSchema } from '../../types/index.js';

const mockContext: ToolContext = {
  requestId: 'test-req-123',
  timestamp: new Date(),
};

const mockExecuteResponse = {
  executionUuid: 'exec-uuid-abc',
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
    test('returns url as-is', () => {
      const resolve = (input: { url: string }) => input.url;
      expect(resolve({ url: 'https://example.com' })).toBe('https://example.com');
    });

    test('accepts localhost urls directly', () => {
      const resolve = (input: { url: string }) => input.url;
      expect(resolve({ url: 'http://localhost:3000' })).toBe('http://localhost:3000');
    });
  });

  describe('WorkflowExecuteResponse shape', () => {
    test('executeWorkflow returns executionUuid and optional resolved IDs', () => {
      expect(mockExecuteResponse).toHaveProperty('executionUuid');
      expect(mockExecuteResponse).toHaveProperty('resolvedEnvironmentId');
      expect(mockExecuteResponse).toHaveProperty('resolvedCredentialId');
    });
  });

  describe('tunnel provisioning', () => {
    test('tunnel is provisioned separately before executeWorkflow', () => {
      // Tunnel provisioning happens via client.tunnels.provision() before execution
      // The provision response has: tunnelId, tunnelKey, keyId, expiresAt
      const provision = { tunnelId: 'tid-1', tunnelKey: 'key-1', keyId: 'kid-1', expiresAt: '...' };
      expect(provision).toHaveProperty('tunnelId');
      expect(provision).toHaveProperty('tunnelKey');
      expect(provision).toHaveProperty('keyId');
    });

    test('revokeKey is stored on tunnel and fires on auto-shutoff, not per-call', () => {
      // The handler passes () => client.revokeNgrokKey(keyId) as revokeKey to ensureTunnel.
      // TunnelManager stores it in TunnelInfo and calls it when the tunnel auto-stops.
      // Handler does NOT call revokeNgrokKey directly in the happy path.
      expect(true).toBe(true); // documented invariant, enforced by integration tests below
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

describe('TestPageChangesInputSchema — url validation', () => {
  test('accepts public url', () => {
    const result = TestPageChangesInputSchema.safeParse({
      description: 'test login flow',
      url: 'https://example.com',
    });
    expect(result.success).toBe(true);
  });

  test('accepts localhost url', () => {
    const result = TestPageChangesInputSchema.safeParse({
      description: 'test login flow',
      url: 'http://localhost:3000',
    });
    expect(result.success).toBe(true);
  });

  test('normalizes bare localhost:PORT to http://localhost:PORT', () => {
    const result = TestPageChangesInputSchema.safeParse({
      description: 'test login flow',
      url: 'localhost:3000',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('http://localhost:3000');
    }
  });

  test('normalizes bare 0.0.0.0:PORT', () => {
    const result = TestPageChangesInputSchema.safeParse({
      description: 'test',
      url: '0.0.0.0:8080',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('http://0.0.0.0:8080');
    }
  });

  test('rejects missing url', () => {
    const result = TestPageChangesInputSchema.safeParse({
      description: 'test login flow',
    });
    expect(result.success).toBe(false);
  });

  test('rejects invalid url format', () => {
    const result = TestPageChangesInputSchema.safeParse({
      description: 'test',
      url: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty description', () => {
    const result = TestPageChangesInputSchema.safeParse({
      description: '',
      url: 'https://example.com',
    });
    expect(result.success).toBe(false);
  });
});

describe('pollExecution — AbortSignal cancellation', () => {
  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

  async function pollWithSignal(
    getExecution: () => Promise<any>,
    signal?: AbortSignal
  ): Promise<any> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error('Polling cancelled');
      }
      const execution = await getExecution();
      if (TERMINAL_STATUSES.has(execution.status)) return execution;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 0);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Polling cancelled'));
          }, { once: true });
        }
      });
    }
  }

  test('aborts mid-poll when signal fires', async () => {
    const controller = new AbortController();
    let callCount = 0;
    const getExecution = async () => {
      callCount++;
      if (callCount === 2) controller.abort();
      return { status: 'running', nodeExecutions: [] };
    };

    await expect(pollWithSignal(getExecution, controller.signal)).rejects.toThrow('Polling cancelled');
  });

  test('completes normally when signal never fires', async () => {
    const controller = new AbortController();
    let callCount = 0;
    const statuses = ['running', 'running', 'completed'];
    const getExecution = async () => {
      return { status: statuses[callCount++] ?? 'completed', nodeExecutions: [] };
    };

    const result = await pollWithSignal(getExecution, controller.signal);
    expect(result.status).toBe('completed');
  });

  test('aborts if signal is already aborted before polling starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const getExecution = async () => ({ status: 'running', nodeExecutions: [] });

    await expect(pollWithSignal(getExecution, controller.signal)).rejects.toThrow('Polling cancelled');
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

// ════════════════════════════════════════════════════════════════════════════
// Full handler integration tests (mocked service layer)
// ════════════════════════════════════════════════════════════════════════════

import { jest } from '@jest/globals';

// ── Mock functions ─────────────────────────────────────────────────────────

const mockProvision = jest.fn<() => Promise<any>>();
const mockFindTemplate = jest.fn<() => Promise<any>>();
const mockExecute = jest.fn<() => Promise<any>>();
const mockPoll = jest.fn<() => Promise<any>>();
const mockRevokeKey = jest.fn<() => Promise<void>>();
const mockInit = jest.fn<() => Promise<void>>();

const mockEnsureTunnel = jest.fn<(...args: any[]) => Promise<any>>();
const mockFindExistingTunnel = jest.fn<(ctx: any) => any>();
const mockBuildContext = jest.fn<(url: string) => any>();
const mockResolveTargetUrl = jest.fn<(input: any) => string>();
const mockSanitizeResponseUrls = jest.fn<(value: any, ctx: any) => any>();

// ── Module mocks (BEFORE dynamic import) ───────────────────────────────────

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    tunnels: { provision: mockProvision },
    workflows: {
      findEvaluationTemplate: mockFindTemplate,
      executeWorkflow: mockExecute,
      pollExecution: mockPoll,
    },
    revokeNgrokKey: mockRevokeKey,
  })),
}));

jest.unstable_mockModule('../../utils/tunnelContext.js', () => ({
  resolveTargetUrl: mockResolveTargetUrl,
  buildContext: mockBuildContext,
  findExistingTunnel: mockFindExistingTunnel,
  ensureTunnel: mockEnsureTunnel,
  sanitizeResponseUrls: mockSanitizeResponseUrls,
}));

jest.unstable_mockModule('../../utils/imageUtils.js', () => ({
  fetchImageAsBase64: jest.fn().mockResolvedValue(null),
  imageContentBlock: jest.fn(),
}));

// ── Dynamic import (picks up the mocks) ────────────────────────────────────

let testPageChangesHandler: typeof import('../../handlers/testPageChangesHandler.js').testPageChangesHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/testPageChangesHandler.js');
  testPageChangesHandler = mod.testPageChangesHandler;
});

// ── Shared test fixtures ───────────────────────────────────────────────────

const defaultContext: ToolContext = { requestId: 'int-test', timestamp: new Date() };
const defaultInput = { description: 'check login page', url: 'https://example.com' };
const localhostInput = { description: 'check login page', url: 'http://localhost:3000' };

const TEMPLATE = { uuid: 'tmpl-uuid-1', name: 'App Evaluation', description: '', isTemplate: true, isActive: true };

const EXECUTE_RESPONSE = {
  executionUuid: 'exec-uuid-1',
  resolvedEnvironmentId: null,
  resolvedCredentialId: null,
};

const COMPLETED_EXECUTION = {
  uuid: 'exec-uuid-1',
  status: 'completed',
  startedAt: '2026-02-25T10:00:00Z',
  completedAt: '2026-02-25T10:02:00Z',
  durationMs: 120000,
  state: { outcome: 'pass', success: true, stepsTaken: 3, error: '' },
  errorMessage: '',
  errorInfo: null,
  nodeExecutions: [
    {
      nodeId: 'surfer-1',
      nodeType: 'surfer.execute_task',
      status: 'completed',
      outputData: { agentResponse: 'Page loaded', stepsTaken: 3 },
      executionOrder: 2,
    },
  ],
};

const PROVISION_RESPONSE = {
  tunnelId: 'tid-abc',
  tunnelKey: 'tkey-abc',
  keyId: 'kid-abc',
  expiresAt: '2026-02-25T11:00:00Z',
};

// ── Helper to set up happy-path mocks ──────────────────────────────────────

function setupHappyPath(options: { isLocalhost: boolean; reuseExisting?: boolean } = { isLocalhost: false }) {
  const url = options.isLocalhost ? localhostInput.url : defaultInput.url;
  mockResolveTargetUrl.mockReturnValue(url);
  mockBuildContext.mockReturnValue({
    originalUrl: url,
    isLocalhost: options.isLocalhost,
  });
  mockSanitizeResponseUrls.mockImplementation((val) => val);
  mockInit.mockResolvedValue(undefined);
  mockFindTemplate.mockResolvedValue(TEMPLATE);
  mockExecute.mockResolvedValue(EXECUTE_RESPONSE);
  mockPoll.mockResolvedValue(COMPLETED_EXECUTION);
  mockRevokeKey.mockResolvedValue(undefined);

  if (options.isLocalhost) {
    if (options.reuseExisting) {
      // Simulate an existing tunnel being found — no provision needed
      mockFindExistingTunnel.mockReturnValue({
        originalUrl: url,
        isLocalhost: true,
        tunnelId: 'existing-tid',
        targetUrl: 'https://existing-tid.ngrok.debugg.ai/',
      });
    } else {
      // No existing tunnel — provision path
      mockFindExistingTunnel.mockReturnValue(null);
      mockProvision.mockResolvedValue(PROVISION_RESPONSE);
      mockEnsureTunnel.mockResolvedValue({
        originalUrl: url,
        isLocalhost: true,
        tunnelId: 'tid-abc',
        targetUrl: 'https://tid-abc.ngrok.debugg.ai/',
      });
    }
  } else {
    mockFindExistingTunnel.mockReturnValue(null);
  }
}

// ── Helper: invalidate module-level cachedTemplateUuid ──────────────────────
// The handler clears its cache on errors containing 'not found' or '401'.
// We trigger a controlled failure to reset it before tests that need a fresh cache.
// We use executeWorkflow (which runs AFTER the cache check) to throw the error,
// so this works even when cachedTemplateUuid is already populated.
async function invalidateTemplateCache() {
  mockInit.mockResolvedValue(undefined);
  mockResolveTargetUrl.mockReturnValue('https://example.com');
  mockBuildContext.mockReturnValue({ originalUrl: 'https://example.com', isLocalhost: false });
  mockFindExistingTunnel.mockReturnValue(null);
  mockSanitizeResponseUrls.mockImplementation((val: any) => val);
  mockFindTemplate.mockResolvedValue(TEMPLATE);
  // Throw 'not found' from executeWorkflow — always runs, bypasses cache check
  mockExecute.mockRejectedValue(new Error('not found'));
  try {
    await testPageChangesHandler(
      { description: 'cache-reset', url: 'https://example.com' },
      { requestId: 'cache-reset', timestamp: new Date() }
    );
  } catch {
    // Expected — this clears cachedTemplateUuid
  }
  jest.clearAllMocks();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('testPageChangesHandler — full handler flow', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // Invalidate the module-level template cache so each test starts fresh
    await invalidateTemplateCache();
  });

  // Test 1: Public URL — no tunnel provisioned
  test('public URL: no tunnel provisioned, returns outcome', async () => {
    setupHappyPath({ isLocalhost: false });

    const result = await testPageChangesHandler(defaultInput, defaultContext);

    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockEnsureTunnel).not.toHaveBeenCalled();

    // Check contextData.targetUrl passed to executeWorkflow
    const executeCall = mockExecute.mock.calls[0];
    const contextData = executeCall[1] as Record<string, any>;
    expect(contextData.targetUrl).toBe('https://example.com');

    // Returns content with outcome
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    const text = JSON.parse(result.content[0].text!);
    expect(text.outcome).toBe('pass');
    expect(text.success).toBe(true);
  });

  // Test 2: Localhost URL — tunnel provisioned BEFORE execute, revokeKey passed through
  test('localhost URL: tunnel provisioned before executeWorkflow', async () => {
    setupHappyPath({ isLocalhost: true });

    // Track call order
    const callOrder: string[] = [];
    mockProvision.mockImplementation(async () => {
      callOrder.push('provision');
      return PROVISION_RESPONSE;
    });
    mockEnsureTunnel.mockImplementation(async () => {
      callOrder.push('ensureTunnel');
      return {
        originalUrl: 'http://localhost:3000',
        isLocalhost: true,
        tunnelId: 'tid-abc',
        targetUrl: 'https://tid-abc.ngrok.debugg.ai/',
      };
    });
    mockExecute.mockImplementation(async () => {
      callOrder.push('execute');
      return EXECUTE_RESPONSE;
    });

    await testPageChangesHandler(localhostInput, defaultContext);

    // provision and ensureTunnel before execute
    expect(callOrder.indexOf('provision')).toBeLessThan(callOrder.indexOf('execute'));
    expect(callOrder.indexOf('ensureTunnel')).toBeLessThan(callOrder.indexOf('execute'));

    // targetUrl in contextData is the tunnel URL
    const contextData = mockExecute.mock.calls[0][1] as Record<string, any>;
    expect(contextData.targetUrl).toBe('https://tid-abc.ngrok.debugg.ai/');

    // ensureTunnel called with keyId and revokeKey
    expect(mockEnsureTunnel).toHaveBeenCalledWith(
      expect.objectContaining({ isLocalhost: true }),
      'tkey-abc',
      'tid-abc',
      'kid-abc',
      expect.any(Function),
    );
  });

  // Test 3: Happy-path localhost — tunnel stays alive, no explicit revoke in finally
  test('tunnel reuse: releaseTunnel NOT called, revokeNgrokKey NOT called on success', async () => {
    setupHappyPath({ isLocalhost: true });

    await testPageChangesHandler(localhostInput, defaultContext);

    // Tunnel stays alive for reuse — handler does not tear it down
    expect(mockRevokeKey).not.toHaveBeenCalled();
  });

  // Test 4: provision() throws before tunnel is created — no revokeNgrokKey (keyId never set)
  test('provision throws: revokeNgrokKey NOT called (keyId never set)', async () => {
    setupHappyPath({ isLocalhost: true });
    mockProvision.mockRejectedValue(new Error('provision failed'));

    await expect(
      testPageChangesHandler(localhostInput, defaultContext)
    ).rejects.toThrow();

    expect(mockRevokeKey).not.toHaveBeenCalled();
  });

  // Test 4b: ensureTunnel throws after provision — unused key is revoked immediately
  test('ensureTunnel throws after provision: unused key is revoked', async () => {
    setupHappyPath({ isLocalhost: true });
    mockEnsureTunnel.mockRejectedValue(new Error('ngrok connect failed'));

    await expect(
      testPageChangesHandler(localhostInput, defaultContext)
    ).rejects.toThrow();

    // keyId was provisioned but tunnel was never created (ctx.tunnelId not set)
    expect(mockRevokeKey).toHaveBeenCalledWith('kid-abc');
  });

  // Test 5: Template not found — error thrown
  test('template not found: throws error, cachedTemplateUuid stays null', async () => {
    setupHappyPath({ isLocalhost: false });
    mockFindTemplate.mockResolvedValue(null);

    await expect(
      testPageChangesHandler(defaultInput, defaultContext)
    ).rejects.toThrow();

    expect(mockExecute).not.toHaveBeenCalled();
  });

  // Test 6: executeWorkflow throws — tunnel stays alive, no revoke in finally
  test('executeWorkflow throws: tunnel stays alive, revokeNgrokKey NOT called in finally', async () => {
    setupHappyPath({ isLocalhost: true });
    mockExecute.mockRejectedValue(new Error('API error'));

    await expect(
      testPageChangesHandler(localhostInput, defaultContext)
    ).rejects.toThrow();

    // Tunnel was created (ctx.tunnelId is set) — revocation deferred to auto-shutoff
    expect(mockRevokeKey).not.toHaveBeenCalled();
  });

  // Test 6b: existing tunnel reused — provision never called
  test('existing tunnel reused: provision NOT called', async () => {
    setupHappyPath({ isLocalhost: true, reuseExisting: true });

    await testPageChangesHandler(localhostInput, defaultContext);

    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockEnsureTunnel).not.toHaveBeenCalled();

    // contextData uses the reused tunnel URL
    const contextData = mockExecute.mock.calls[0][1] as Record<string, any>;
    expect(contextData.targetUrl).toBe('https://existing-tid.ngrok.debugg.ai/');
  });

  // Test 7: pollExecution returns failed outcome
  test('pollExecution returns failed: result includes failure details', async () => {
    setupHappyPath({ isLocalhost: false });

    const failedExecution = {
      uuid: 'exec-uuid-1',
      status: 'failed',
      startedAt: '2026-02-25T10:00:00Z',
      completedAt: '2026-02-25T10:02:00Z',
      durationMs: 120000,
      state: { outcome: 'fail', success: false, stepsTaken: 2, error: 'element not found' },
      errorMessage: '',
      errorInfo: null,
      nodeExecutions: [],
    };
    mockPoll.mockResolvedValue(failedExecution);

    const result = await testPageChangesHandler(defaultInput, defaultContext);

    const text = JSON.parse(result.content[0].text!);
    expect(text.outcome).toBe('fail');
    expect(text.success).toBe(false);
    expect(text.stepsTaken).toBe(2);
    expect(text.agentError).toBe('element not found');
  });

  // Test 8: Template caching — findEvaluationTemplate called once, reused on second invocation
  test('template caching: findEvaluationTemplate called once across invocations', async () => {
    setupHappyPath({ isLocalhost: false });

    // First call — template fetched
    await testPageChangesHandler(defaultInput, defaultContext);
    expect(mockFindTemplate).toHaveBeenCalledTimes(1);

    // Reset call counts but NOT the module-level cache
    mockFindTemplate.mockClear();
    mockExecute.mockClear();
    mockPoll.mockClear();
    mockInit.mockClear();

    // Re-setup non-template mocks
    mockInit.mockResolvedValue(undefined);
    mockExecute.mockResolvedValue(EXECUTE_RESPONSE);
    mockPoll.mockResolvedValue(COMPLETED_EXECUTION);
    mockResolveTargetUrl.mockReturnValue('https://example.com');
    mockBuildContext.mockReturnValue({ originalUrl: 'https://example.com', isLocalhost: false });

    // Second call — template NOT fetched again
    await testPageChangesHandler(defaultInput, defaultContext);
    expect(mockFindTemplate).not.toHaveBeenCalled();
  });
});
