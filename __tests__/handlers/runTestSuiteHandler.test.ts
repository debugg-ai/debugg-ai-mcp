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
const mockSanitizeResponseUrls = jest.fn<(val: any, ctx: any) => any>().mockImplementation((v: any) => v);

jest.unstable_mockModule('../../utils/localReachability.js', () => ({
  probeLocalPort: mockProbeLocalPort,
  probeTunnelHealth: mockProbeTunnelHealth,
}));

// §2.3: run_test_suite is the ONE named exception that does NOT go through
// findExistingTunnel/ensureTunnel/acquirePortRoute at all — it is
// fire-and-forget (no poll loop, no bounded window to hold the shared
// session lock over), so it gets its own DEDICATED tunnel via
// tunnelManager.acquireDedicatedTunnel(), bypassing Caddy/PortLock entirely.
// buildContext stays real-ish (just isLocalhost detection) since the
// handler's own localhost branch logic depends on it.
jest.unstable_mockModule('../../utils/tunnelContext.js', () => ({
  buildContext: (url: string) => ({
    originalUrl: url,
    isLocalhost: url.includes('localhost') || url.includes('127.0.0.1'),
    targetUrl: url,
    tunnelId: undefined,
  }),
  sanitizeResponseUrls: mockSanitizeResponseUrls,
}));

jest.unstable_mockModule('../../services/tunnels.js', () => ({
  TunnelProvisionError: class TunnelProvisionError extends Error {},
}));

// Named so tests can assert on what the handler did NOT do to the tunnel — this
// handler used to tear one down on EVERY health-probe failure, at two billed
// hours a time (see utils/tunnelDisposition.ts).
const mockStopTunnel = jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any);
const mockMarkTunnelDead = jest.fn<(...a: any[]) => Promise<void>>().mockResolvedValue(undefined as any);
// §2.3's run_test_suite exception: acquireDedicatedTunnel dials ngrok
// directly, bypassing Caddy/PortLock — always mints a FRESH tunnel, never
// deduped/reused (unlike ensureSessionTunnel).
const mockAcquireDedicatedTunnel = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: {
    stopTunnel: mockStopTunnel,
    markTunnelDead: mockMarkTunnelDead,
    acquireDedicatedTunnel: mockAcquireDedicatedTunnel,
  },
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
    mockSanitizeResponseUrls.mockImplementation((v: any) => v);
    mockProbeLocalPort.mockResolvedValue({ reachable: true, code: 'OK', elapsedMs: 5 });
    mockProbeTunnelHealth.mockResolvedValue({ healthy: true, elapsedMs: 10 });
    mockProvisionWithRetry.mockResolvedValue({ tunnelKey: 'key', tunnelId: 'tid', keyId: 'kid' });
    mockAcquireDedicatedTunnel.mockResolvedValue({ url: 'https://abc.ngrok.io', tunnelId: 'tid' });
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

  describe('localhost tunnel — §2.3 dedicated-tunnel exception', () => {
    test('localhost targetUrl: provisions a DEDICATED tunnel (bypasses Caddy/PortLock) and substitutes URL', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      expect(mockProbeLocalPort).toHaveBeenCalledWith(3011);
      expect(mockProvisionWithRetry).toHaveBeenCalled();
      expect(mockAcquireDedicatedTunnel).toHaveBeenCalledWith(
        'http://localhost:3011', 'key', 'kid', expect.any(Function),
      );
      expect(mockRunTestSuite).toHaveBeenCalledWith(
        SUITE_UUID,
        expect.objectContaining({ targetUrl: 'https://abc.ngrok.io' }),
      );
    });

    // §2.3: acquireDedicatedTunnel is NEVER deduped/reused — every call mints
    // a fresh tunnel (unlike ensureSessionTunnel's per-session reuse). There
    // is no "findExistingTunnel" fast path for this handler at all anymore.
    test('localhost targetUrl: every call provisions its OWN fresh dedicated tunnel (no reuse)', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      expect(mockProvisionWithRetry).toHaveBeenCalledTimes(2);
      expect(mockAcquireDedicatedTunnel).toHaveBeenCalledTimes(2);
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
      // ERR_NGROK_8012 = the tunnel is ALIVE and its upstream refused. This
      // handler used to tear the tunnel down on EVERY health failure and never
      // got bead k34o at all; it now shares the allowlist with the other three.
      // A teardown plus its forced re-provision costs two billed hours.
      expect(mockMarkTunnelDead).not.toHaveBeenCalled();
      expect(mockStopTunnel).not.toHaveBeenCalled();
    });

    test('localhost targetUrl: NETWORK_ERROR health failure leaves the tunnel alone', async () => {
      // The only shape a real probe failure takes on this edge (bead kmzb) — and
      // indistinguishable from bead k6yq's transient GOAWAY flake, so it can
      // never justify destroying a tunnel we are already paying for.
      mockProbeTunnelHealth.mockResolvedValue({
        healthy: false, code: 'NETWORK_ERROR',
        detail: 'fetch failed (UND_ERR_SOCKET: HTTP/2 "GOAWAY" frame received with code 0)',
        elapsedMs: 800,
      });

      const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text!).error).toBe('TunnelTrafficBlocked');
      expect(mockMarkTunnelDead).not.toHaveBeenCalled();
      expect(mockStopTunnel).not.toHaveBeenCalled();
      // The key is NOT revoked either: it authenticates the tunnel we just kept,
      // and revoking a live tunnel's credential would kill what we preserved.
      expect(mockRevokeNgrokKey).not.toHaveBeenCalled();
    });

    test('localhost targetUrl: ERR_NGROK_3200 evicts the proven-dead endpoint', async () => {
      mockProbeTunnelHealth.mockResolvedValue({
        healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_3200',
        status: 404, detail: 'endpoint offline', elapsedMs: 60,
      });

      const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      expect(res.isError).toBe(true);
      // markTunnelDead, not stopTunnel: only the former evicts the SHARED registry
      // entry, which is what stops other sessions re-borrowing the corpse (k34o).
      // §2.3: markTunnelDead dropped its `port` parameter — no longer port-scoped.
      expect(mockMarkTunnelDead).toHaveBeenCalledWith(expect.any(String));
      expect(mockStopTunnel).not.toHaveBeenCalled();
    });

    test('public targetUrl: no tunnel provisioned, URL passed through unchanged', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'https://staging.example.com' }, ctx);

      expect(mockProbeLocalPort).not.toHaveBeenCalled();
      expect(mockProvisionWithRetry).not.toHaveBeenCalled();
      expect(mockAcquireDedicatedTunnel).not.toHaveBeenCalled();
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

  // Bead debugg_ai_mcp-6cfv.7: this handler previously had NO sanitize call at
  // all — add a defensive pass, exercised here by asserting it actually runs
  // against the response payload for a localhost target.
  describe('defensive sanitizeResponseUrls call (bead debugg_ai_mcp-6cfv.7)', () => {
    test('localhost target: sanitizeResponseUrls is called against the response payload', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      expect(mockSanitizeResponseUrls).toHaveBeenCalledWith(
        expect.objectContaining({ suiteUuid: SUITE_UUID, tunnelActive: true }),
        expect.objectContaining({ isLocalhost: true, tunnelId: 'tid' }),
      );
    });

    test('a tunnel hostname leaking into the backend response is stripped before returning', async () => {
      // Use a field name distinct from the handler's own fixed `note` field
      // (which always overwrites whatever the backend sent under that key).
      mockRunTestSuite.mockResolvedValue({ ...RUN_RESPONSE, statusUrl: 'https://abc.ngrok.io/status' });
      mockSanitizeResponseUrls.mockImplementation((value: any) =>
        JSON.parse(JSON.stringify(value).replace(/https:\/\/abc\.ngrok\.io/g, 'http://localhost:3011')),
      );

      const res = await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'http://localhost:3011' }, ctx);

      const body = JSON.parse(res.content[0].text!);
      expect(body.statusUrl).toBe('http://localhost:3011/status');
    });

    test('public target: sanitizeResponseUrls is NOT called (no tunnel ctx to scope it to)', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID, targetUrl: 'https://staging.example.com' }, ctx);

      // sanitizeResponseUrls itself no-ops for non-localhost ctx (§ tunnelContext.ts
      // contract), but this handler doesn't even have a ctx to pass when there
      // was never a localhost target — sanitizeCtx stays undefined.
      expect(mockSanitizeResponseUrls).not.toHaveBeenCalled();
    });

    test('no targetUrl at all: sanitizeResponseUrls is NOT called', async () => {
      await runTestSuiteHandler({ suiteUuid: SUITE_UUID }, ctx);

      expect(mockSanitizeResponseUrls).not.toHaveBeenCalled();
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
