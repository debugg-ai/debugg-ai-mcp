/**
 * Dev mode tests for triggerCrawlHandler.
 * Verifies that DEBUGGAI_DEV_MODE=true bypasses tunnel provisioning.
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

jest.unstable_mockModule('../../config/index.js', () => ({
  config: {
    api: { key: 'test-key', baseUrl: 'http://localhost:8012', tokenType: 'token' },
    devMode: true,
    server: { name: 'DebuggAI MCP Server', version: '0.0.0-test' },
    defaults: {},
    logging: { level: 'info', format: 'simple' },
    telemetry: { posthogApiKey: undefined },
  },
}));

const mockInit = jest.fn<() => Promise<void>>();
const mockFindTemplateByName = jest.fn<(kw: string) => Promise<any>>();
const mockExecute = jest.fn<(...args: any[]) => Promise<any>>();
const mockPoll = jest.fn<(...args: any[]) => Promise<any>>();
const mockProvision = jest.fn<() => Promise<any>>();
const mockRevokeKey = jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any);

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    tunnels: { provision: mockProvision, provisionWithRetry: mockProvision },
    workflows: {
      findTemplateByName: mockFindTemplateByName,
      executeWorkflow: mockExecute,
      pollExecution: mockPoll,
    },
    revokeNgrokKey: mockRevokeKey,
  })),
}));

const mockProbeLocalPort = jest.fn<(...args: any[]) => Promise<any>>();
const mockProbeTunnelHealth = jest.fn<(...args: any[]) => Promise<any>>();
const mockEnsureTunnel = jest.fn<(...args: any[]) => Promise<any>>();
const mockFindExistingTunnel = jest.fn<(ctx: any) => any>();
const mockBuildContext = jest.fn<(url: string) => any>();
const mockResolveTargetUrl = jest.fn<(input: any) => string>();
const mockSanitizeResponseUrls = jest.fn<(val: any, ctx: any) => any>().mockImplementation((v) => v);
const mockTouchTunnelById = jest.fn();

jest.unstable_mockModule('../../utils/tunnelContext.js', () => ({
  resolveTargetUrl: mockResolveTargetUrl,
  buildContext: mockBuildContext,
  findExistingTunnel: mockFindExistingTunnel,
  ensureTunnel: mockEnsureTunnel,
  sanitizeResponseUrls: mockSanitizeResponseUrls,
  touchTunnelById: mockTouchTunnelById,
}));

jest.unstable_mockModule('../../utils/localReachability.js', () => ({
  probeLocalPort: mockProbeLocalPort,
  probeTunnelHealth: mockProbeTunnelHealth,
}));

jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: { stopTunnel: jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any) },
}));

let triggerCrawlHandler: typeof import('../../handlers/triggerCrawlHandler.js').triggerCrawlHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/triggerCrawlHandler.js');
  triggerCrawlHandler = mod.triggerCrawlHandler;
});

const ctx: ToolContext = { requestId: 'dev-mode-crawl', timestamp: new Date() };
const LOCALHOST_URL = 'http://localhost:3000';

const COMPLETED_EXECUTION = {
  uuid: 'crawl-exec-1',
  status: 'completed',
  durationMs: 5000,
  state: { outcome: 'success', stepsTaken: 3 },
  errorMessage: '',
  errorInfo: null,
  nodeExecutions: [],
};

describe('triggerCrawlHandler — dev mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockResolveTargetUrl.mockReturnValue(LOCALHOST_URL);
    mockBuildContext.mockReturnValue({ originalUrl: LOCALHOST_URL, isLocalhost: true, targetUrl: LOCALHOST_URL, tunnelId: undefined });
    mockFindExistingTunnel.mockReturnValue(null);
    mockSanitizeResponseUrls.mockImplementation((v) => v);
    mockProbeLocalPort.mockResolvedValue({ reachable: true, code: 'OK', elapsedMs: 5 });
    mockFindTemplateByName.mockResolvedValue({ uuid: 'tmpl-crawl-uuid' });
    mockExecute.mockResolvedValue({ executionUuid: 'crawl-exec-1', resolvedEnvironmentId: null, resolvedCredentialId: null });
    mockPoll.mockImplementation(async (_uuid, onUpdate) => {
      await onUpdate(COMPLETED_EXECUTION);
      return COMPLETED_EXECUTION;
    });
  });

  test('localhost url passes through without tunnel provisioning', async () => {
    const res = await triggerCrawlHandler({ url: LOCALHOST_URL }, ctx);

    expect(res.isError).toBeFalsy();
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockEnsureTunnel).not.toHaveBeenCalled();
    expect(mockProbeTunnelHealth).not.toHaveBeenCalled();
  });

  test('TCP pre-flight still runs in dev mode', async () => {
    await triggerCrawlHandler({ url: LOCALHOST_URL }, ctx);

    expect(mockProbeLocalPort).toHaveBeenCalledWith(3000);
  });

  test('localhost url is forwarded to executeWorkflow as-is', async () => {
    await triggerCrawlHandler({ url: LOCALHOST_URL }, ctx);

    expect(mockExecute).toHaveBeenCalledWith(
      'tmpl-crawl-uuid',
      expect.objectContaining({ targetUrl: LOCALHOST_URL }),
      undefined,
    );
  });
});
