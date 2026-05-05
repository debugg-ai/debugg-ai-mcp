/**
 * Dev mode tests for probePageHandler.
 * Verifies that DEBUGGAI_DEV_MODE=true bypasses tunnel provisioning per-target.
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

const mockProbeLocalPort = jest.fn<(port: number) => Promise<any>>();
const mockProbeTunnelHealth = jest.fn<(url: string) => Promise<any>>();
const mockEnsureTunnel = jest.fn<(...args: any[]) => Promise<any>>();
const mockFindExistingTunnel = jest.fn<(ctx: any) => any>();
const mockBuildContext = jest.fn<(url: string) => any>();
const mockSanitizeResponseUrls = jest.fn<(val: any, ctx: any) => any>().mockImplementation((v) => v);
const mockTouchTunnelById = jest.fn();

jest.unstable_mockModule('../../utils/tunnelContext.js', () => ({
  resolveTargetUrl: jest.fn<(input: any) => string>(),
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

let probePageHandler: typeof import('../../handlers/probePageHandler.js').probePageHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/probePageHandler.js');
  probePageHandler = mod.probePageHandler;
});

const ctx: ToolContext = { requestId: 'dev-mode-probe', timestamp: new Date() };
const LOCALHOST_URL = 'http://localhost:3000';

const CAPTURE_NODE = {
  nodeId: 'cap-1',
  nodeType: 'browser.capture',
  status: 'success',
  executionOrder: 1,
  outputData: {
    capturedUrl: LOCALHOST_URL,
    statusCode: 200,
    title: 'Home',
    loadTimeMs: 300,
    consoleSlice: [],
    networkSummary: [],
  },
};

const COMPLETED_EXECUTION = {
  uuid: 'probe-exec-1',
  status: 'completed',
  durationMs: 2000,
  state: null,
  errorMessage: '',
  errorInfo: null,
  nodeExecutions: [CAPTURE_NODE],
};

describe('probePageHandler — dev mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockBuildContext.mockImplementation((url: string) => ({
      originalUrl: url,
      isLocalhost: url.includes('localhost') || url.includes('127.0.0.1'),
      targetUrl: url,
      tunnelId: undefined,
    }));
    mockFindExistingTunnel.mockReturnValue(null);
    mockSanitizeResponseUrls.mockImplementation((v) => v);
    mockProbeLocalPort.mockResolvedValue({ reachable: true, code: 'OK', elapsedMs: 5 });
    mockFindTemplateByName.mockResolvedValue({ uuid: 'tmpl-probe-uuid' });
    mockExecute.mockResolvedValue({ executionUuid: 'probe-exec-1', resolvedEnvironmentId: null, resolvedCredentialId: null });
    mockPoll.mockImplementation(async (_uuid, onUpdate) => {
      await onUpdate(COMPLETED_EXECUTION);
      return COMPLETED_EXECUTION;
    });
  });

  test('localhost target passes through without tunnel provisioning', async () => {
    const res = await probePageHandler(
      { targets: [{ url: LOCALHOST_URL }], includeHtml: false, captureScreenshots: false },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockEnsureTunnel).not.toHaveBeenCalled();
    expect(mockProbeTunnelHealth).not.toHaveBeenCalled();
  });

  test('TCP pre-flight still runs in dev mode for localhost target', async () => {
    await probePageHandler(
      { targets: [{ url: LOCALHOST_URL }], includeHtml: false, captureScreenshots: false },
      ctx,
    );

    expect(mockProbeLocalPort).toHaveBeenCalledWith(3000);
  });
});
