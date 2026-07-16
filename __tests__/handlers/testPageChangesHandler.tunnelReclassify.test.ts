/**
 * Bug debugg_ai_mcp-z15n — a tunnel that dies MID-RUN must not surface as a UI
 * 'fail' that blames the user's page.
 *
 * The pre-flight probe (bead 1om) proves the tunnel was alive when we handed it
 * to the remote browser, but it can still die during the run. Execution
 * a8f07747-232f-4c37-87b5-9cf69f6e67ec passed pre-flight, ran 217s, and the
 * remote browser landed on ngrok's ERR_NGROK_3200 interstitial — which came back
 * as outcome 'fail' with a reason blaming the user's View button.
 *
 * Epic 56kd is "relay honestly, invent nothing", so reclassification is allowed
 * ONLY on POSITIVE local evidence that the tunnel is dead:
 *   - our own post-run re-probe actually failing, or
 *   - an explicit ERR_NGROK_* marker recorded by the run itself.
 * A healthy re-probe must relay the backend verdict VERBATIM — a genuine UI
 * failure must never be laundered into an infrastructure excuse.
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

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

const mockProbeLocalPort = jest.fn<(...args: any[]) => Promise<any>>();
const mockProbeTunnelHealth = jest.fn<(...args: any[]) => Promise<any>>();

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

// The probes are mocked (they hit the real network); extractNgrokErrorCode is a
// pure regex helper, so the double mirrors the real implementation exactly
// rather than stubbing away the behaviour under test.
jest.unstable_mockModule('../../utils/localReachability.js', () => ({
  probeLocalPort: mockProbeLocalPort,
  probeTunnelHealth: mockProbeTunnelHealth,
  extractNgrokErrorCode: (body: string) => body.match(/ERR_NGROK_\d+/)?.[0],
}));

jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: { stopTunnel: jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any) },
}));

let testPageChangesHandler: typeof import('../../handlers/testPageChangesHandler.js').testPageChangesHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/testPageChangesHandler.js');
  testPageChangesHandler = mod.testPageChangesHandler;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const ctx: ToolContext = { requestId: 'z15n-test', timestamp: new Date() };

const LOCALHOST_URL = 'http://localhost:3011/projects/83fa71e2/graphs';
const PUBLIC_URL = 'https://example.com';
const TUNNEL_URL = 'https://687ba5fa-8dd5-45df-bfa2-32cdc09804f5.ngrok.debugg.ai/';

const localhostInput = { description: 'check the View button layout', url: LOCALHOST_URL };
const publicInput = { description: 'check the View button layout', url: PUBLIC_URL };

const TEMPLATE = { uuid: 'tmpl-uuid-1', name: 'App Evaluation', description: '', isTemplate: true, isActive: true };
const EXECUTE_RESPONSE = { executionUuid: 'exec-uuid-1', resolvedEnvironmentId: null, resolvedCredentialId: null };
const PROVISION_RESPONSE = { tunnelId: 'tid-abc', tunnelKey: 'tkey-abc', keyId: 'kid-abc', expiresAt: '2026-07-15T11:00:00Z' };

/** Verbatim from the bead: the backend blames the page for OUR dead tunnel. */
const BACKEND_FAIL_REASON =
  'The target ngrok endpoint is offline, so the View button layout cannot be evaluated.';

const HEALTHY = { healthy: true, status: 200, elapsedMs: 1 };
const DEAD_TUNNEL = {
  healthy: false,
  status: 404,
  code: 'NGROK_ERROR',
  ngrokErrorCode: 'ERR_NGROK_3200',
  detail: 'ngrok returned ERR_NGROK_3200 — endpoint is offline',
  elapsedMs: 42,
};

function makeExecution(overrides: Record<string, any> = {}) {
  return {
    uuid: 'exec-uuid-1',
    status: 'completed',
    startedAt: '2026-07-14T01:15:00Z',
    completedAt: '2026-07-14T01:18:37Z',
    durationMs: 217675,
    state: { outcome: 'fail', success: false, stepsTaken: 7, error: '' },
    verdict: { outcome: 'fail', reason: BACKEND_FAIL_REASON },
    budget: { maxSteps: 25, usedSteps: 7 },
    evidence: {
      actionTrace: [{ step: 1, action: 'navigate', intent: 'Open the graphs page', success: true }],
    },
    errorMessage: '',
    errorInfo: null,
    nodeExecutions: [],
    ...overrides,
  };
}

function setup(opts: { isLocalhost: boolean }) {
  const url = opts.isLocalhost ? LOCALHOST_URL : PUBLIC_URL;
  mockResolveTargetUrl.mockReturnValue(url);
  mockBuildContext.mockReturnValue({ originalUrl: url, isLocalhost: opts.isLocalhost });
  mockSanitizeResponseUrls.mockImplementation((val) => val);
  mockInit.mockResolvedValue(undefined);
  mockFindTemplate.mockResolvedValue(TEMPLATE);
  mockFindProject.mockResolvedValue({ uuid: 'proj-xyz', name: 'Test Project' });
  mockExecute.mockResolvedValue(EXECUTE_RESPONSE);
  mockRevokeKey.mockResolvedValue(undefined);
  mockProbeLocalPort.mockResolvedValue({ reachable: true, elapsedMs: 1 });
  mockFindExistingTunnel.mockReturnValue(null);

  if (opts.isLocalhost) {
    mockProvision.mockResolvedValue(PROVISION_RESPONSE);
    mockEnsureTunnel.mockResolvedValue({
      originalUrl: url,
      isLocalhost: true,
      tunnelId: 'tid-abc',
      targetUrl: TUNNEL_URL,
    });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('testPageChangesHandler — mid-run tunnel death is not a UI fail (bug z15n)', () => {
  test('backend fail + tunnel re-probe now UNHEALTHY → reclassified as infrastructure, backend reason preserved', async () => {
    setup({ isLocalhost: true });
    mockPoll.mockResolvedValue(makeExecution());
    // 1st call = pre-flight (passes, as it did for a8f07747); 2nd = post-run re-probe.
    mockProbeTunnelHealth.mockResolvedValueOnce(HEALTHY).mockResolvedValueOnce(DEAD_TUNNEL);

    const result = await testPageChangesHandler(localhostInput, ctx);

    // We actually re-probed rather than guessing.
    expect(mockProbeTunnelHealth).toHaveBeenCalledTimes(2);
    expect(mockProbeTunnelHealth).toHaveBeenNthCalledWith(2, TUNNEL_URL);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.error).toBe('TunnelOfflineDuringRun');
    expect(payload.failureCategory).toBe('infrastructure');
    expect(payload.outcome).toBe('error');
    expect(payload.success).toBe(false);
    expect(result.isError).toBe(true);

    // The backend's original verdict is preserved, not swallowed.
    expect(payload.backendVerdict).toEqual({ outcome: 'fail', reason: BACKEND_FAIL_REASON });

    // Our own observation is what we assert as the cause — nothing invented.
    expect(payload.detail.ngrokErrorCode).toBe('ERR_NGROK_3200');
    expect(payload.detail.probeCode).toBe('NGROK_ERROR');

    // Run identity is still relayed so the caller can dig into the execution.
    expect(payload.executionId).toBe('exec-uuid-1');
    expect(payload.durationMs).toBe(217675);
  });

  test('backend fail + tunnel re-probe HEALTHY → verdict relayed VERBATIM (no over-reach)', async () => {
    setup({ isLocalhost: true });
    mockPoll.mockResolvedValue(makeExecution());
    // Tunnel is fine both before and after — this is a genuine UI failure, even
    // though the backend's reason happens to mention the word "ngrok".
    mockProbeTunnelHealth.mockResolvedValue(HEALTHY);

    const result = await testPageChangesHandler(localhostInput, ctx);

    expect(mockProbeTunnelHealth).toHaveBeenCalledTimes(2);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.outcome).toBe('fail');
    expect(payload.success).toBe(false);
    expect(payload.failureCategory).toBe('fail');
    expect(payload.reason).toBe(BACKEND_FAIL_REASON);
    expect(payload.error).toBeUndefined();
    expect(payload.backendVerdict).toBeUndefined();
    expect(result.isError).toBeUndefined();
  });

  test('backend fail + NO tunnel (direct public URL) → no re-probe attempted, verdict verbatim', async () => {
    setup({ isLocalhost: false });
    mockPoll.mockResolvedValue(makeExecution());

    const result = await testPageChangesHandler(publicInput, ctx);

    // Nothing of ours to blame — never probe a URL we don't own.
    expect(mockProbeTunnelHealth).not.toHaveBeenCalled();

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.outcome).toBe('fail');
    expect(payload.failureCategory).toBe('fail');
    expect(payload.reason).toBe(BACKEND_FAIL_REASON);
    expect(payload.error).toBeUndefined();
    expect(result.isError).toBeUndefined();
  });

  test('backend pass → no re-probe, no reclassification', async () => {
    setup({ isLocalhost: true });
    mockPoll.mockResolvedValue(
      makeExecution({
        state: { outcome: 'pass', success: true, stepsTaken: 4, error: '' },
        verdict: { outcome: 'pass', reason: 'The View button is aligned correctly.' },
      }),
    );
    mockProbeTunnelHealth.mockResolvedValue(HEALTHY);

    const result = await testPageChangesHandler(localhostInput, ctx);

    // Only the pre-flight probe — a pass is never re-litigated.
    expect(mockProbeTunnelHealth).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.outcome).toBe('pass');
    expect(payload.success).toBe(true);
    expect(payload.error).toBeUndefined();
    expect(result.isError).toBeUndefined();
  });

  test('backend fail + ERR_NGROK_* marker in the run evidence → reclassified even if the tunnel recovered', async () => {
    setup({ isLocalhost: true });
    mockPoll.mockResolvedValue(
      makeExecution({
        evidence: {
          actionTrace: [
            { step: 6, action: 'navigate', intent: 'Re-navigate to the graphs page', success: true },
            {
              step: 7,
              action: 'observe',
              intent: 'Page shows ERR_NGROK_3200: the endpoint is offline',
              success: false,
            },
          ],
        },
      }),
    );
    // Tunnel answers again by the time we re-probe — but the run itself recorded
    // the interstitial, which is positive evidence it was down during the run.
    mockProbeTunnelHealth.mockResolvedValue(HEALTHY);

    const result = await testPageChangesHandler(localhostInput, ctx);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.error).toBe('TunnelOfflineDuringRun');
    expect(payload.failureCategory).toBe('infrastructure');
    expect(payload.detail.ngrokErrorCode).toBe('ERR_NGROK_3200');
    expect(payload.backendVerdict).toEqual({ outcome: 'fail', reason: BACKEND_FAIL_REASON });
    expect(result.isError).toBe(true);
  });
});
