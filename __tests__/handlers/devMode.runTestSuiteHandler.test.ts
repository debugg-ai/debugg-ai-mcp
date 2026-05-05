/**
 * Dev mode tests for runTestSuiteHandler.
 * Verifies that DEBUGGAI_DEV_MODE=true bypasses tunnel provisioning and passes
 * the localhost URL directly to the backend.
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

// Mock config with devMode: true before any handler import.
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
const mockRunTestSuite = jest.fn<(...args: any[]) => Promise<any>>();
const mockProvisionWithRetry = jest.fn<(...args: any[]) => Promise<any>>();
const mockRevokeNgrokKey = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined as any);

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    runTestSuite: mockRunTestSuite,
    tunnels: { provisionWithRetry: mockProvisionWithRetry },
    revokeNgrokKey: mockRevokeNgrokKey,
  })),
}));

const mockProbeLocalPort = jest.fn<(...args: any[]) => Promise<any>>();
const mockProbeTunnelHealth = jest.fn<(...args: any[]) => Promise<any>>();
const mockFindExistingTunnel = jest.fn<(...args: any[]) => any>();
const mockEnsureTunnel = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../utils/localReachability.js', () => ({
  probeLocalPort: mockProbeLocalPort,
  probeTunnelHealth: mockProbeTunnelHealth,
}));

jest.unstable_mockModule('../../utils/tunnelContext.js', () => ({
  buildContext: (url: string) => ({
    originalUrl: url,
    isLocalhost: url.includes('localhost') || url.includes('127.0.0.1'),
    targetUrl: url,
    tunnelId: undefined,
  }),
  findExistingTunnel: mockFindExistingTunnel,
  ensureTunnel: mockEnsureTunnel,
  sanitizeResponseUrls: (v: any) => v,
  touchTunnelById: jest.fn(),
}));

jest.unstable_mockModule('../../services/tunnels.js', () => ({
  TunnelProvisionError: class TunnelProvisionError extends Error {},
}));

jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: { stopTunnel: jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any) },
}));

let runTestSuiteHandler: typeof import('../../handlers/runTestSuiteHandler.js').runTestSuiteHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/runTestSuiteHandler.js');
  runTestSuiteHandler = mod.runTestSuiteHandler;
});

const ctx: ToolContext = { requestId: 'dev-mode-test', timestamp: new Date() };
const SUITE_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RUN_RESPONSE = { suiteUuid: SUITE_UUID, runStatus: 'PENDING', testsTriggered: 2 };
const LOCALHOST_URL = 'http://localhost:3011';

describe('runTestSuiteHandler — dev mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockRunTestSuite.mockResolvedValue(RUN_RESPONSE);
    mockProbeLocalPort.mockResolvedValue({ reachable: true, code: 'OK', elapsedMs: 5 });
  });

  test('localhost targetUrl passes through without tunnel provisioning', async () => {
    const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: LOCALHOST_URL }, ctx);

    expect(res.isError).toBeFalsy();
    expect(mockProvisionWithRetry).not.toHaveBeenCalled();
    expect(mockEnsureTunnel).not.toHaveBeenCalled();
    expect(mockProbeTunnelHealth).not.toHaveBeenCalled();
    expect(mockRunTestSuite).toHaveBeenCalledWith(SUITE_UUID, { targetUrl: LOCALHOST_URL });
  });

  test('TCP pre-flight still runs in dev mode', async () => {
    const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: LOCALHOST_URL }, ctx);

    expect(res.isError).toBeFalsy();
    expect(mockProbeLocalPort).toHaveBeenCalledWith(3011);
  });

  test('dev mode still returns LocalServerUnreachable when port is not listening', async () => {
    mockProbeLocalPort.mockResolvedValue({ reachable: false, code: 'ECONNREFUSED', detail: 'nothing there', elapsedMs: 5 });

    const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: LOCALHOST_URL }, ctx);

    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text as string);
    expect(body.error).toBe('LocalServerUnreachable');
    expect(mockProvisionWithRetry).not.toHaveBeenCalled();
  });

  test('public targetUrl is unaffected by dev mode (no tunnel needed anyway)', async () => {
    const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'https://example.com' }, ctx);

    expect(res.isError).toBeFalsy();
    expect(mockProvisionWithRetry).not.toHaveBeenCalled();
    expect(mockRunTestSuite).toHaveBeenCalledWith(SUITE_UUID, { targetUrl: 'https://example.com' });
  });
});
