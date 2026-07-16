/**
 * Bug debugg_ai_mcp-5er7 — a client abort must cancel the BACKEND execution,
 * not just our poll.
 *
 * Wiring context.signal to an AbortController (see testPageChangesHandler.ts)
 * stops the poll and frees the MAX_CONCURRENT slot, but the backend execution
 * keeps running to its own timeout (contextData.timeoutSeconds = 720), driving
 * a real browser session and burning quota with nobody reading the result.
 *
 * Invariants under test:
 *   1. abort AFTER an execution is queued  → cancelExecution(uuid) exactly once
 *   2. abort BEFORE anything is queued     → never POST a cancel for an empty uuid
 *   3. an execution queued despite a prior abort is cancelled, not leaked
 *   4. cancelExecution REJECTS             → handler settles as it otherwise would
 *   5. normal completion                   → cancelExecution NOT called
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

// ── Mocks (declared BEFORE the module factories that close over them) ──────

const mockInit = jest.fn<() => Promise<void>>();
const mockFindTemplate = jest.fn<() => Promise<any>>();
const mockExecute = jest.fn<(...args: any[]) => Promise<any>>();
const mockPoll = jest.fn<(...args: any[]) => Promise<any>>();
const mockCancelExecution = jest.fn<(uuid: string) => Promise<void>>();
const mockRevokeKey = jest.fn<() => Promise<void>>();
const mockFindProject = jest.fn<(repo: string) => Promise<any>>();
const mockProvision = jest.fn<() => Promise<any>>();

const mockEnsureTunnel = jest.fn<(...args: any[]) => Promise<any>>();
const mockFindExistingTunnel = jest.fn<(ctx: any) => any>();
const mockBuildContext = jest.fn<(url: string) => any>();
const mockResolveTargetUrl = jest.fn<(input: any) => string>();
const mockSanitizeResponseUrls = jest.fn<(value: any, ctx: any) => any>();
const mockTouchTunnelById = jest.fn<(id: string) => void>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    tunnels: { provision: mockProvision, provisionWithRetry: mockProvision },
    workflows: {
      findEvaluationTemplate: mockFindTemplate,
      executeWorkflow: mockExecute,
      pollExecution: mockPoll,
      cancelExecution: mockCancelExecution,
    },
    revokeNgrokKey: mockRevokeKey,
    findProjectByRepoName: mockFindProject,
  })),
}));

jest.unstable_mockModule('../../utils/tunnelContext.js', () => ({
  resolveTargetUrl: mockResolveTargetUrl,
  buildContext: mockBuildContext,
  findExistingTunnel: mockFindExistingTunnel,
  ensureTunnel: mockEnsureTunnel,
  sanitizeResponseUrls: mockSanitizeResponseUrls,
  touchTunnelById: mockTouchTunnelById,
}));

jest.unstable_mockModule('../../utils/imageUtils.js', () => ({
  fetchImageAsBase64: jest.fn().mockResolvedValue(null as any),
  imageContentBlock: jest.fn((data: string) => ({ type: 'image', data, mimeType: 'image/png' })),
  resourceLinkBlock: jest.fn((uri: string, name: string) => ({ type: 'resource_link', uri, name })),
  artifactResourceLinks: jest.fn(() => []),
}));

jest.unstable_mockModule('../../utils/localReachability.js', () => ({
  probeLocalPort: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ reachable: true, elapsedMs: 1 }),
  probeTunnelHealth: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ healthy: true, status: 200, elapsedMs: 1 }),
  extractNgrokErrorCode: jest.fn(() => undefined),
}));

jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: { stopTunnel: jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any) },
}));

// ── Dynamic import (picks up the mocks) ────────────────────────────────────

let testPageChangesHandler: typeof import('../../handlers/testPageChangesHandler.js').testPageChangesHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/testPageChangesHandler.js');
  testPageChangesHandler = mod.testPageChangesHandler;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const PUBLIC_URL = 'https://example.com';
const publicInput = { description: 'check the login page', url: PUBLIC_URL };

const TEMPLATE = { uuid: 'tmpl-uuid-1', name: 'App Evaluation', description: '', isTemplate: true, isActive: true };

const EXECUTE_RESPONSE = {
  executionUuid: 'exec-uuid-1',
  resolvedEnvironmentId: null,
  resolvedCredentialId: null,
};

const COMPLETED_EXECUTION = {
  uuid: 'exec-uuid-1',
  status: 'completed',
  startedAt: '2026-07-15T10:00:00Z',
  completedAt: '2026-07-15T10:02:00Z',
  durationMs: 120000,
  state: { outcome: 'pass', success: true, stepsTaken: 3, error: '' },
  verdict: { outcome: 'pass', reason: 'The login page renders correctly.' },
  errorMessage: '',
  errorInfo: null,
  nodeExecutions: [],
};

/** Public-URL happy path: no tunnel, template + project resolve, execution queues. */
function setupPublicUrlPath() {
  mockResolveTargetUrl.mockReturnValue(PUBLIC_URL);
  mockBuildContext.mockReturnValue({ originalUrl: PUBLIC_URL, isLocalhost: false });
  mockFindExistingTunnel.mockReturnValue(null);
  mockSanitizeResponseUrls.mockImplementation((val) => val);
  mockInit.mockResolvedValue(undefined);
  mockFindTemplate.mockResolvedValue(TEMPLATE);
  mockFindProject.mockResolvedValue({ uuid: 'proj-xyz', name: 'Test Project' });
  mockExecute.mockResolvedValue(EXECUTE_RESPONSE);
  mockPoll.mockResolvedValue(COMPLETED_EXECUTION);
  mockCancelExecution.mockResolvedValue(undefined);
  mockRevokeKey.mockResolvedValue(undefined);
}

/**
 * Stand-in for the real pollExecution's abort behaviour: it rejects as soon as
 * the handler's internal AbortController fires (services/workflows.ts:263).
 */
function pollThatRejectsOnAbort(beforeWait?: () => void) {
  return async (uuid: any, _onUpdate: any, signal: any) => {
    beforeWait?.();
    return new Promise<any>((_resolve, reject) => {
      const fail = () => reject(new Error(`Polling cancelled for execution ${uuid}`));
      if (signal?.aborted) return fail();
      signal?.addEventListener('abort', fail, { once: true });
    });
  };
}

function ctxWith(signal: AbortSignal): ToolContext {
  return { requestId: 'abort-test', timestamp: new Date(), signal };
}

/** Let fire-and-forget promises settle and any unhandled rejection surface. */
const drainMicrotasks = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('testPageChangesHandler — abort cancels the backend execution (bug 5er7)', () => {
  test('abort AFTER an execution is queued → cancelExecution called once with that executionUuid', async () => {
    setupPublicUrlPath();
    const request = new AbortController();
    // Abort mid-poll — i.e. after executeWorkflow returned exec-uuid-1.
    mockPoll.mockImplementation(pollThatRejectsOnAbort(() => request.abort()));

    await expect(
      testPageChangesHandler(publicInput, ctxWith(request.signal)),
    ).rejects.toThrow(/Polling cancelled/);

    await drainMicrotasks();

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockCancelExecution).toHaveBeenCalledTimes(1);
    expect(mockCancelExecution).toHaveBeenCalledWith('exec-uuid-1');
  });

  test('abort BEFORE anything is queued → no cancel is POSTed for an empty/undefined uuid', async () => {
    setupPublicUrlPath();
    const request = new AbortController();
    // Abort during client.init(), i.e. before the abort listener is even wired
    // and long before executeWorkflow. Exercises the `signal.aborted` fast path.
    mockInit.mockImplementation(async () => {
      request.abort();
    });

    // Snapshot the cancel calls at the moment the FIRST execution is queued:
    // everything before that point had no uuid to cancel.
    let cancelCallsWhenQueued: unknown[][] = [];
    mockExecute.mockImplementation(async () => {
      cancelCallsWhenQueued = mockCancelExecution.mock.calls.slice();
      return EXECUTE_RESPONSE;
    });
    mockPoll.mockImplementation(pollThatRejectsOnAbort());

    await expect(
      testPageChangesHandler(publicInput, ctxWith(request.signal)),
    ).rejects.toThrow(/Polling cancelled/);

    await drainMicrotasks();

    // Nothing was queued when the abort fired → nothing to cancel at that point.
    expect(cancelCallsWhenQueued).toEqual([]);
    // And we must never POST cancel/<empty>/ at any point in the request.
    for (const [uuid] of mockCancelExecution.mock.calls) {
      expect(uuid).toBeTruthy();
    }
  });

  test('an execution queued despite an earlier abort is cancelled, not leaked', async () => {
    setupPublicUrlPath();
    const request = new AbortController();
    // Client drops while we are still setting up. The handler has no abort check
    // between here and executeWorkflow, so a 12-minute browser run still gets
    // queued — it must not be abandoned.
    mockInit.mockImplementation(async () => {
      request.abort();
    });
    mockPoll.mockImplementation(pollThatRejectsOnAbort());

    await expect(
      testPageChangesHandler(publicInput, ctxWith(request.signal)),
    ).rejects.toThrow(/Polling cancelled/);

    await drainMicrotasks();

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockCancelExecution).toHaveBeenCalledWith('exec-uuid-1');
  });

  test('cancelExecution REJECTS → handler still settles normally, no unhandled rejection', async () => {
    setupPublicUrlPath();
    mockCancelExecution.mockRejectedValue(new Error('cancel endpoint returned 500'));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const request = new AbortController();
      mockPoll.mockImplementation(pollThatRejectsOnAbort(() => request.abort()));

      // Settles with the ABORT error the handler would have produced anyway —
      // the rejected cancel must never surface to the caller.
      await expect(
        testPageChangesHandler(publicInput, ctxWith(request.signal)),
      ).rejects.toThrow(/Polling cancelled/);

      await drainMicrotasks();

      expect(mockCancelExecution).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('normal completion (no abort) → cancelExecution NOT called', async () => {
    setupPublicUrlPath();
    const request = new AbortController(); // never aborted

    const result = await testPageChangesHandler(publicInput, ctxWith(request.signal));

    await drainMicrotasks();

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.outcome).toBe('pass');
    expect(mockCancelExecution).not.toHaveBeenCalled();
  });

  test('no request signal at all → cancelExecution NOT called', async () => {
    setupPublicUrlPath();

    await testPageChangesHandler(publicInput, { requestId: 'no-signal', timestamp: new Date() });

    await drainMicrotasks();

    expect(mockCancelExecution).not.toHaveBeenCalled();
  });
});
