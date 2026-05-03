import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockRunTestSuite = jest.fn<(...args: any[]) => Promise<any>>();
const mockListTestSuites = jest.fn<(...args: any[]) => Promise<any>>();
const mockListProjects = jest.fn<(...args: any[]) => Promise<any>>();
const mockProvisionWithRetry = jest.fn<(...args: any[]) => Promise<any>>();
const mockRevokeNgrokKey = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined as any);

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    runTestSuite: mockRunTestSuite,
    listTestSuites: mockListTestSuites,
    listProjects: mockListProjects,
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

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };

const PROJECT_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SUITE_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RUN_RESPONSE = { suiteUuid: SUITE_UUID, runStatus: 'PENDING', testsTriggered: 3 };

describe('runTestSuiteHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockRunTestSuite.mockResolvedValue(RUN_RESPONSE);
    mockFindExistingTunnel.mockReturnValue(null);
    mockProbeLocalPort.mockResolvedValue({ reachable: true, code: 'OK', elapsedMs: 5 });
    mockProbeTunnelHealth.mockResolvedValue({ healthy: true, elapsedMs: 10 });
    mockProvisionWithRetry.mockResolvedValue({ tunnelKey: 'key', tunnelId: 'tid', keyId: 'kid' });
    mockEnsureTunnel.mockResolvedValue({ targetUrl: 'https://abc.ngrok.io', tunnelId: 'tid', isLocalhost: true, originalUrl: 'http://localhost:3011' });
  });

  describe('uuid mode', () => {
    test('suiteUuid: calls runTestSuite directly', async () => {
      const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID }, ctx);

      expect(mockListTestSuites).not.toHaveBeenCalled();
      expect(mockRunTestSuite).toHaveBeenCalledWith(SUITE_UUID, expect.any(Object));
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.suiteUuid).toBe(SUITE_UUID);
      expect(body.runStatus).toBe('PENDING');
      expect(body.testsTriggered).toBe(3);
    });

    test('targetUrl forwarded when provided', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'https://staging.example.com' }, ctx);

      expect(mockRunTestSuite).toHaveBeenCalledWith(
        SUITE_UUID,
        expect.objectContaining({ targetUrl: 'https://staging.example.com' }),
      );
    });

    test('targetUrl omitted when not provided', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID }, ctx);

      const callArg = mockRunTestSuite.mock.calls[0]?.[1] as any;
      expect(callArg?.targetUrl).toBeUndefined();
    });
  });

  describe('name resolution', () => {
    test('suiteName + projectUuid: resolves suite then runs', async () => {
      mockListTestSuites.mockResolvedValue({
        pageInfo: {},
        suites: [{ uuid: SUITE_UUID, name: 'Smoke Tests' }],
      });

      const res = await runTestSuiteHandler(
        { suiteName: 'Smoke Tests', projectUuid: PROJECT_UUID },
        ctx,
      );

      expect(mockListTestSuites).toHaveBeenCalled();
      expect(mockRunTestSuite).toHaveBeenCalledWith(SUITE_UUID, expect.any(Object));
      expect(res.isError).not.toBe(true);
    });

    test('suiteName + projectName: resolves both then runs', async () => {
      mockListProjects.mockResolvedValue({ pageInfo: {}, projects: [{ uuid: PROJECT_UUID, name: 'My App' }] });
      mockListTestSuites.mockResolvedValue({ pageInfo: {}, suites: [{ uuid: SUITE_UUID, name: 'Smoke Tests' }] });

      const res = await runTestSuiteHandler(
        { suiteName: 'Smoke Tests', projectName: 'My App' },
        ctx,
      );

      expect(mockRunTestSuite).toHaveBeenCalledWith(SUITE_UUID, expect.any(Object));
      expect(res.isError).not.toBe(true);
    });
  });

  describe('response', () => {
    test('response includes async note (runs are not synchronous)', async () => {
      const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID }, ctx);

      const body = JSON.parse(res.content[0].text!);
      expect(body.runStatus).toBeDefined();
      expect(['PENDING', 'RUNNING']).toContain(body.runStatus);
    });
  });

  describe('localhost tunnel', () => {
    test('localhost targetUrl: provisions tunnel and substitutes URL', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      expect(mockProbeLocalPort).toHaveBeenCalledWith(3011);
      expect(mockProvisionWithRetry).toHaveBeenCalled();
      expect(mockEnsureTunnel).toHaveBeenCalled();
      expect(mockRunTestSuite).toHaveBeenCalledWith(
        SUITE_UUID,
        expect.objectContaining({ targetUrl: 'https://abc.ngrok.io' }),
      );
    });

    test('localhost targetUrl: reuses existing tunnel without re-provisioning', async () => {
      mockFindExistingTunnel.mockReturnValue({
        targetUrl: 'https://existing.ngrok.io',
        tunnelId: 'existing-tid',
        isLocalhost: true,
        originalUrl: 'http://localhost:3011',
      });

      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      expect(mockProvisionWithRetry).not.toHaveBeenCalled();
      expect(mockRunTestSuite).toHaveBeenCalledWith(
        SUITE_UUID,
        expect.objectContaining({ targetUrl: 'https://existing.ngrok.io' }),
      );
    });

    test('localhost targetUrl: LocalServerUnreachable when port not listening', async () => {
      mockProbeLocalPort.mockResolvedValue({ reachable: false, code: 'ECONNREFUSED', detail: 'Connection refused', elapsedMs: 5 });

      const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toBe('LocalServerUnreachable');
      expect(mockRunTestSuite).not.toHaveBeenCalled();
    });

    test('localhost targetUrl: TunnelTrafficBlocked when health probe fails', async () => {
      mockProbeTunnelHealth.mockResolvedValue({ healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_8012', detail: 'Cannot connect to host', elapsedMs: 100 });

      const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toBe('TunnelTrafficBlocked');
      expect(mockRunTestSuite).not.toHaveBeenCalled();
    });

    test('public targetUrl: no tunnel provisioned, URL passed through unchanged', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'https://staging.example.com' }, ctx);

      expect(mockProbeLocalPort).not.toHaveBeenCalled();
      expect(mockProvisionWithRetry).not.toHaveBeenCalled();
      expect(mockRunTestSuite).toHaveBeenCalledWith(
        SUITE_UUID,
        expect.objectContaining({ targetUrl: 'https://staging.example.com' }),
      );
    });

    test('response includes tunnelActive and originalUrl when tunneled', async () => {
      const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      const body = JSON.parse(res.content[0].text!);
      expect(body.tunnelActive).toBe(true);
      expect(body.originalUrl).toBe('http://localhost:3011');
    });
  });

  describe('error paths', () => {
    test('suiteName not found: isError:true', async () => {
      mockListTestSuites.mockResolvedValue({ pageInfo: {}, suites: [] });

      const res = await runTestSuiteHandler(
        { suiteName: 'ghost', projectUuid: PROJECT_UUID },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(mockRunTestSuite).not.toHaveBeenCalled();
    });
  });
});
