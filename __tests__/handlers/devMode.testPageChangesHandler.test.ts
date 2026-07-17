/**
 * Dev mode tests for testPageChangesHandler (check_app_in_browser).
 * Verifies that DEBUGGAI_DEV_MODE=true bypasses tunnel provisioning.
 *
 * Uses env var + _resetConfigForTest rather than module mock for config
 * because testPageChangesHandler's concurrency wrapper loads before beforeAll,
 * making the module-mock approach unreliable for the first test invocation.
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockExecuteWorkflow = jest.fn<(...args: any[]) => Promise<any>>();
const mockPollExecution = jest.fn<(...args: any[]) => Promise<any>>();
const mockFindEvaluationTemplate = jest.fn<() => Promise<any>>();
const mockProvisionWithRetry = jest.fn<(...args: any[]) => Promise<any>>();
const mockRevokeNgrokKey = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined as any);
// project_id is required (bead 56kd.5) — resolve a linked project so the
// dev-mode flow proceeds past the fail-fast guard.
const mockFindProjectByRepoName = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ uuid: 'proj-dev', name: 'Dev Project' });

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    workflows: {
      findEvaluationTemplate: mockFindEvaluationTemplate,
      executeWorkflow: mockExecuteWorkflow,
      pollExecution: mockPollExecution,
    },
    tunnels: { provisionWithRetry: mockProvisionWithRetry },
    revokeNgrokKey: mockRevokeNgrokKey,
    findProjectByRepoName: mockFindProjectByRepoName,
  })),
}));

const mockProbeLocalPort = jest.fn<(...args: any[]) => Promise<any>>();
const mockProbeTunnelHealth = jest.fn<(...args: any[]) => Promise<any>>();
const mockEnsureTunnel = jest.fn<(...args: any[]) => Promise<any>>();
const mockFindExistingTunnel = jest.fn<(...args: any[]) => any>();
const mockBuildContext = jest.fn<(url: string) => any>();
const mockResolveTargetUrl = jest.fn<(input: any) => string>();
const mockSanitizeResponseUrls = jest.fn<(val: any, ctx: any) => any>().mockImplementation((v) => v);
const mockTouchTunnelById = jest.fn();

jest.unstable_mockModule('../../utils/localReachability.js', () => ({
  probeLocalPort: mockProbeLocalPort,
  probeTunnelHealth: mockProbeTunnelHealth,
  // Bug z15n: the handler imports this to spot ngrok's interstitial marker in
  // run evidence. Pure regex helper — mirror the real implementation.
  extractNgrokErrorCode: (body: string) => body.match(/ERR_NGROK_\d+/)?.[0],
}));

jest.unstable_mockModule('../../utils/tunnelContext.js', () => ({
  resolveTargetUrl: mockResolveTargetUrl,
  buildContext: mockBuildContext,
  findExistingTunnel: mockFindExistingTunnel,
  ensureTunnel: mockEnsureTunnel,
  sanitizeResponseUrls: mockSanitizeResponseUrls,
  touchTunnelById: mockTouchTunnelById,
}));

jest.unstable_mockModule('../../services/tunnels.js', () => ({
  TunnelProvisionError: class TunnelProvisionError extends Error {},
}));

jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: { stopTunnel: jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any), markTunnelDead: jest.fn<(...a: any[]) => Promise<void>>().mockResolvedValue(undefined as any) },
}));

let testPageChangesHandler: typeof import('../../handlers/testPageChangesHandler.js').testPageChangesHandler;
let _resetConfigForTest: typeof import('../../config/index.js')._resetConfigForTest;

beforeAll(async () => {
  const mod = await import('../../handlers/testPageChangesHandler.js');
  testPageChangesHandler = mod.testPageChangesHandler;
  const cfg = await import('../../config/index.js');
  _resetConfigForTest = cfg._resetConfigForTest;
});

const ctx: ToolContext = { requestId: 'dev-mode-check-app', timestamp: new Date() };
const LOCALHOST_URL = 'http://localhost:3000';

const COMPLETED_EXECUTION = {
  uuid: 'exec-abc',
  status: 'completed',
  durationMs: 10000,
  state: { outcome: 'pass', success: true, stepsTaken: 2, error: '' },
  errorMessage: '',
  errorInfo: null,
  nodeExecutions: [],
};

describe('testPageChangesHandler — dev mode', () => {
  beforeEach(() => {
    process.env.DEBUGGAI_DEV_MODE = 'true';
    process.env.DEBUGGAI_API_KEY = 'test-key';
    _resetConfigForTest();

    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockFindProjectByRepoName.mockResolvedValue({ uuid: 'proj-dev', name: 'Dev Project' });
    mockResolveTargetUrl.mockReturnValue(LOCALHOST_URL);
    mockBuildContext.mockReturnValue({ originalUrl: LOCALHOST_URL, isLocalhost: true, targetUrl: LOCALHOST_URL, tunnelId: undefined });
    mockFindExistingTunnel.mockReturnValue(null);
    mockSanitizeResponseUrls.mockImplementation((v) => v);
    mockProbeLocalPort.mockResolvedValue({ reachable: true, code: 'OK', elapsedMs: 5 });
    mockFindEvaluationTemplate.mockResolvedValue({ uuid: 'tmpl-uuid-eval', name: 'app evaluation' });
    mockExecuteWorkflow.mockResolvedValue({ executionUuid: 'exec-abc', resolvedEnvironmentId: null, resolvedCredentialId: null });
    mockPollExecution.mockImplementation(async (_uuid: any, onUpdate: any) => {
      await onUpdate(COMPLETED_EXECUTION);
      return COMPLETED_EXECUTION;
    });
  });

  afterEach(() => {
    delete process.env.DEBUGGAI_DEV_MODE;
    _resetConfigForTest();
  });

  test('localhost url passes through without tunnel provisioning', async () => {
    const res = await testPageChangesHandler({ url: LOCALHOST_URL, description: 'check login' }, ctx);

    expect(res.isError).toBeFalsy();
    expect(mockProvisionWithRetry).not.toHaveBeenCalled();
    expect(mockEnsureTunnel).not.toHaveBeenCalled();
    expect(mockProbeTunnelHealth).not.toHaveBeenCalled();
  });

  test('TCP pre-flight still runs in dev mode', async () => {
    await testPageChangesHandler({ url: LOCALHOST_URL, description: 'check login' }, ctx);

    expect(mockProbeLocalPort).toHaveBeenCalledWith(3000);
  });

  test('localhost url is forwarded to executeWorkflow as-is', async () => {
    await testPageChangesHandler({ url: LOCALHOST_URL, description: 'check nav' }, ctx);

    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      'tmpl-uuid-eval',
      expect.objectContaining({ targetUrl: LOCALHOST_URL }),
      undefined,
    );
  });
});
