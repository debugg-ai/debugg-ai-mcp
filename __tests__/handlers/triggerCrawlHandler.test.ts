/**
 * Tests for triggerCrawlHandler — proof point for bead ew8 + bead 8ji.
 *
 * Structure mirrors testPageChangesHandler.test.ts (same mock scaffolding)
 * but the surface under test resolves the crawl template by stable slug
 * (findTemplateBySlug, bead 56kd.8) and returns a crawl-shaped response without
 * outcome pass/fail semantics.
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockProvision = jest.fn<() => Promise<any>>();
const mockFindTemplateBySlug = jest.fn<(kw: string) => Promise<any>>();
const mockFindEvaluationTemplate = jest.fn<() => Promise<any>>();
const mockExecute = jest.fn<(...args: any[]) => Promise<any>>();
const mockPoll = jest.fn<() => Promise<any>>();
const mockRevokeKey = jest.fn<() => Promise<void>>();
const mockInit = jest.fn<() => Promise<void>>();

const mockEnsureTunnel = jest.fn<(...args: any[]) => Promise<any>>();
const mockFindExistingTunnel = jest.fn<(ctx: any) => any>();
const mockBuildContext = jest.fn<(url: string) => any>();
const mockResolveTargetUrl = jest.fn<(input: any) => string>();
const mockSanitizeResponseUrls = jest.fn<(value: any, ctx: any) => any>();
const mockTouchTunnelById = jest.fn<(id: string) => void>();
// §5.5 "trigger_crawl lock-wiring parity" test: named so tests can assert
// acquirePortRoute fires after ensureTunnel/before probeTunnelHealth and
// releasePortRoute fires in the finally — identically to check_app_in_browser
// / probe_page (§2.3: trigger_crawl polls, it is NOT a fire-and-forget
// exception — only run_test_suite is).
const mockRouteLockRelease = jest.fn();
const mockAcquirePortRoute = jest.fn(async (ctx: any) =>
  ctx.isLocalhost && ctx.tunnelId ? { ...ctx, routeLock: { release: mockRouteLockRelease } } : ctx);
const mockReleasePortRoute = jest.fn();

// sentinal-lwtaw.13: the handler attaches the LOCAL git ref to contextData.
// Mock the git read so the test is hermetic (doesn't depend on this checkout).
const mockDetectLocalGitRef = jest.fn<() => Promise<{ branch?: string; commitSha?: string }>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    tunnels: { provision: mockProvision, provisionWithRetry: mockProvision },
    workflows: {
      findTemplateBySlug: mockFindTemplateBySlug,
      findEvaluationTemplate: mockFindEvaluationTemplate,
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
  // §2.4: mirrors the real acquirePortRoute's no-op contract (public URL /
  // no tunnelId → unchanged ctx) so tests exercising a real localhost ctx
  // still get a routeLock to release.
  acquirePortRoute: mockAcquirePortRoute,
  releasePortRoute: mockReleasePortRoute,
  sanitizeResponseUrls: mockSanitizeResponseUrls,
  touchTunnelById: mockTouchTunnelById,
}));

// Bead 1om: probes run against real network by default — mock as healthy.
const mockProbeLocalPort = jest.fn<(...args: any[]) => Promise<any>>()
  .mockResolvedValue({ reachable: true, elapsedMs: 1 });
const mockProbeTunnelHealth = jest.fn<(...args: any[]) => Promise<any>>()
  .mockResolvedValue({ healthy: true, status: 200, elapsedMs: 1 });
jest.unstable_mockModule('../../utils/localReachability.js', () => ({
  probeLocalPort: mockProbeLocalPort,
  probeTunnelHealth: mockProbeTunnelHealth,
}));

// A failed health probe may evict the tunnel (only when the endpoint is PROVEN
// gone — see utils/tunnelDisposition.ts). Named so tests can assert on what the
// handler did NOT do: tearing a live tunnel down costs two billed hours.
const mockStopTunnel = jest.fn<() => Promise<void>>().mockResolvedValue();
const mockMarkTunnelDead = jest.fn<(...a: any[]) => Promise<void>>().mockResolvedValue();
jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: { stopTunnel: mockStopTunnel, markTunnelDead: mockMarkTunnelDead },
}));

jest.unstable_mockModule('../../utils/gitContext.js', () => ({
  detectLocalGitRef: mockDetectLocalGitRef,
  detectRepoName: jest.fn<() => string | null>().mockReturnValue(null),
}));

let triggerCrawlHandler: typeof import('../../handlers/triggerCrawlHandler.js').triggerCrawlHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/triggerCrawlHandler.js');
  triggerCrawlHandler = mod.triggerCrawlHandler;
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const defaultContext: ToolContext = { requestId: 'int-crawl', timestamp: new Date() };
const publicInput = { url: 'https://example.com' };
const localhostInput = { url: 'http://localhost:3000' };

const TEMPLATE = {
  uuid: 'tmpl-raw-crawl-uuid',
  name: 'Raw Crawl Workflow Template',
  description: 'Crawls an app to build a KG',
  isTemplate: true,
  isActive: true,
};

const EXECUTE_RESPONSE = {
  executionUuid: 'crawl-exec-uuid-1',
  resolvedEnvironmentId: null,
  resolvedCredentialId: null,
};

// Shape verified against real backend execution (2026-04-22, executionId e3c6888b).
// Keys are camelCase because our axios transport converts snake↔camel at the wire.
const CRAWL_OUTPUT = {
  success: true,
  crawlSuccess: true,
  status: 'succeeded',
  crawlerId: 'crawler-abc',
  stepsTaken: 3,
  actionsExecuted: 5,
  pagesDiscovered: 7,
  transitionsRecorded: 6,
  knowledgeGraphStates: 7,
  error: '',
};

const KG_IMPORT_OUTPUT = {
  skipped: false,
  reason: '',
  edgesImported: 12,
  statesImported: 7,
  knowledgeGraphId: 'kg-uuid-xyz',
  importErrors: [],
};

const COMPLETED_EXECUTION = {
  uuid: 'crawl-exec-uuid-1',
  status: 'completed',
  startedAt: '2026-04-22T10:00:00Z',
  completedAt: '2026-04-22T10:05:00Z',
  durationMs: 300000,
  state: { outcome: 'success', stepsTaken: 8 },
  errorMessage: '',
  errorInfo: null,
  nodeExecutions: [
    { nodeId: 'n-1', nodeType: 'trigger.event', status: 'success', outputData: {}, executionOrder: 1 },
    { nodeId: 'n-2', nodeType: 'browser.setup', status: 'success', outputData: {}, executionOrder: 2 },
    { nodeId: 'n-3', nodeType: 'surfer.crawl', status: 'success', outputData: CRAWL_OUTPUT, executionOrder: 3 },
    { nodeId: 'n-4', nodeType: 'knowledge_graph.import', status: 'success', outputData: KG_IMPORT_OUTPUT, executionOrder: 4 },
    { nodeId: 'n-5', nodeType: 'browser.teardown', status: 'success', outputData: {}, executionOrder: 5 },
  ],
};

const PROVISION_RESPONSE = {
  tunnelId: 'tid-crawl',
  tunnelKey: 'tkey-crawl',
  keyId: 'kid-crawl',
  expiresAt: '2026-04-22T11:00:00Z',
};

function setupHappyPath(options: { isLocalhost: boolean } = { isLocalhost: false }) {
  const url = options.isLocalhost ? localhostInput.url : publicInput.url;
  mockResolveTargetUrl.mockReturnValue(url);
  mockBuildContext.mockReturnValue({ originalUrl: url, isLocalhost: options.isLocalhost });
  mockSanitizeResponseUrls.mockImplementation((val) => val);
  mockInit.mockResolvedValue(undefined);
  mockFindTemplateBySlug.mockResolvedValue(TEMPLATE);
  mockExecute.mockResolvedValue(EXECUTE_RESPONSE);
  mockPoll.mockResolvedValue(COMPLETED_EXECUTION);
  mockRevokeKey.mockResolvedValue(undefined);
  // Default: honest no-git (git-present cases override per-test).
  mockDetectLocalGitRef.mockResolvedValue({});

  if (options.isLocalhost) {
    mockFindExistingTunnel.mockReturnValue(null);
    mockProvision.mockResolvedValue(PROVISION_RESPONSE);
    mockEnsureTunnel.mockResolvedValue({
      originalUrl: url,
      isLocalhost: true,
      tunnelId: PROVISION_RESPONSE.tunnelId,
      targetUrl: `https://${PROVISION_RESPONSE.tunnelId}.ngrok.debugg.ai/`,
    });
  } else {
    mockFindExistingTunnel.mockReturnValue(null);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('triggerCrawlHandler', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // Tests share a process-scoped template cache (utils/handlerCaches.ts).
    // Clear it between tests so mockFindTemplateBySlug.mockResolvedValue(null)
    // is honored instead of a previously-cached uuid being returned.
    const { invalidateTemplateCache, invalidateProjectCache } = await import('../../utils/handlerCaches.js');
    invalidateTemplateCache();
    invalidateProjectCache();
  });

  test('resolves the crawl template by its stable slug (crawl-execution-workflow-template) — no fuzzy name (bead 56kd.8)', async () => {
    setupHappyPath({ isLocalhost: false });
    await triggerCrawlHandler(publicInput, defaultContext);
    expect(mockFindTemplateBySlug).toHaveBeenCalledWith('crawl-execution-workflow-template');
  });

  test('a backend RENAME of the crawl template breaks nothing (slug is the identity)', async () => {
    setupHappyPath({ isLocalhost: false });
    // The "Raw Crawl Workflow Template" name was retired in favor of "Crawl
    // Execution Workflow Template"; dispatching by slug means a rename like that
    // never breaks the handler.
    mockFindTemplateBySlug.mockResolvedValue({ uuid: 'tmpl-raw-crawl-uuid', name: 'Renamed Crawl Template' });
    const result = await triggerCrawlHandler(publicInput, defaultContext);
    expect(JSON.parse(result.content[0].text!).executionId).toBe('crawl-exec-uuid-1');
  });

  test('public URL: no tunnel provisioned; contextData.targetUrl echoes input url', async () => {
    setupHappyPath({ isLocalhost: false });
    await triggerCrawlHandler(publicInput, defaultContext);
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockEnsureTunnel).not.toHaveBeenCalled();
    const [, contextData] = mockExecute.mock.calls[0];
    expect((contextData as any).targetUrl).toBe('https://example.com');
  });

  test('localhost URL: tunnel is provisioned before executeWorkflow', async () => {
    setupHappyPath({ isLocalhost: true });
    const order: string[] = [];
    mockProvision.mockImplementation(async () => { order.push('provision'); return PROVISION_RESPONSE; });
    mockEnsureTunnel.mockImplementation(async () => {
      order.push('ensureTunnel');
      return {
        originalUrl: 'http://localhost:3000',
        isLocalhost: true,
        tunnelId: PROVISION_RESPONSE.tunnelId,
        targetUrl: `https://${PROVISION_RESPONSE.tunnelId}.ngrok.debugg.ai/`,
      };
    });
    mockExecute.mockImplementation(async () => { order.push('execute'); return EXECUTE_RESPONSE; });

    await triggerCrawlHandler(localhostInput, defaultContext);

    expect(order).toEqual(['provision', 'ensureTunnel', 'execute']);
  });

  test('response contains executionId, status, and targetUrl; NO ngrok tunnel URL leak', async () => {
    setupHappyPath({ isLocalhost: true });
    const result = await triggerCrawlHandler(localhostInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);

    expect(body.executionId).toBe('crawl-exec-uuid-1');
    expect(body.status).toBe('completed');
    expect(body.targetUrl).toBe('http://localhost:3000'); // original, not tunnel URL

    const raw = result.content[0].text!;
    expect(raw).not.toMatch(/ngrok\.debugg\.ai/);
  });

  test('response NEVER contains the password, even when password was in input', async () => {
    setupHappyPath({ isLocalhost: false });
    const input = {
      url: 'https://example.com',
      username: 'alice',
      password: 'super-secret-password-9876',
    };

    const result = await triggerCrawlHandler(input, defaultContext);

    const raw = result.content[0].text!;
    expect(raw).not.toContain('super-secret-password-9876');
    // defensive: also no 'password' key in the response JSON
    const body = JSON.parse(raw);
    expect(body).not.toHaveProperty('password');
  });

  test('env block is built from credentialId/environmentId/credentialRole/username/password and passed to executeWorkflow', async () => {
    setupHappyPath({ isLocalhost: false });
    const input = {
      url: 'https://example.com',
      environmentId: '00000000-0000-0000-0000-000000000001',
      credentialId: '00000000-0000-0000-0000-000000000002',
      credentialRole: 'admin',
      username: 'alice',
      password: 'pw',
    };
    await triggerCrawlHandler(input, defaultContext);
    const [, , env] = mockExecute.mock.calls[0];
    expect(env).toEqual({
      environmentId: input.environmentId,
      credentialId: input.credentialId,
      credentialRole: 'admin',
      username: 'alice',
      password: 'pw',
    });
  });

  test('env is omitted when no cred/env fields are provided', async () => {
    setupHappyPath({ isLocalhost: false });
    await triggerCrawlHandler(publicInput, defaultContext);
    const [, , env] = mockExecute.mock.calls[0];
    // Either undefined OR an empty object is acceptable — the service layer
    // omits empty env from the body (verified by workflows.test.ts).
    if (env !== undefined) {
      expect(Object.keys(env)).toHaveLength(0);
    }
  });

  test('optional contextData fields (projectUuid, timeoutSeconds) are threaded correctly', async () => {
    setupHappyPath({ isLocalhost: false });
    const input = {
      url: 'https://example.com',
      projectUuid: '269532cb-0000-0000-0000-000000000000',
      timeoutSeconds: 900,
    };
    await triggerCrawlHandler(input, defaultContext);
    const [, contextData] = mockExecute.mock.calls[0];
    expect((contextData as any).projectId).toBe(input.projectUuid);
    expect((contextData as any).timeoutSeconds).toBe(900);
  });

  test('always runs headless (D7) — contextData.headless is true regardless of input', async () => {
    setupHappyPath({ isLocalhost: false });
    await triggerCrawlHandler({ url: 'https://example.com' }, defaultContext);
    const [, contextData] = mockExecute.mock.calls[0];
    expect((contextData as any).headless).toBe(true);
  });

  // ── Local git ref → git-backed Atlas version (sentinal-lwtaw.13, MCP side) ──
  describe('local git ref threading (sentinal-lwtaw.13)', () => {
    test('git repo: contextData carries commit_sha + branch under the exact backend keys', async () => {
      setupHappyPath({ isLocalhost: false });
      mockDetectLocalGitRef.mockResolvedValue({
        branch: 'staging',
        commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      });

      await triggerCrawlHandler(publicInput, defaultContext);

      const [, contextData] = mockExecute.mock.calls[0];
      // EXACT snake_case keys the PR-webhook path / backend reads.
      expect((contextData as any).commit_sha).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
      expect((contextData as any).branch).toBe('staging');
    });

    test('non-git dir: neither commit_sha nor branch is set (honest no-git, no fabrication) and the crawl still runs', async () => {
      setupHappyPath({ isLocalhost: false });
      mockDetectLocalGitRef.mockResolvedValue({}); // not a git repo / read failed

      const result = await triggerCrawlHandler(publicInput, defaultContext);

      const [, contextData] = mockExecute.mock.calls[0];
      expect(contextData).not.toHaveProperty('commit_sha');
      expect(contextData).not.toHaveProperty('branch');
      // Absent git context NEVER blocks the crawl — it still completes.
      expect(JSON.parse(result.content[0].text!).executionId).toBe('crawl-exec-uuid-1');
    });

    test('partial ref (branch only, no commit): only the present key is attached', async () => {
      setupHappyPath({ isLocalhost: false });
      mockDetectLocalGitRef.mockResolvedValue({ branch: 'feature/x' }); // e.g. packed ref → no loose sha

      await triggerCrawlHandler(publicInput, defaultContext);

      const [, contextData] = mockExecute.mock.calls[0];
      expect((contextData as any).branch).toBe('feature/x');
      expect(contextData).not.toHaveProperty('commit_sha');
    });
  });

  test('template not found: throws a clear error', async () => {
    setupHappyPath({ isLocalhost: false });
    mockFindTemplateBySlug.mockResolvedValue(null);
    await expect(triggerCrawlHandler(publicInput, defaultContext)).rejects.toThrow(
      /[Cc]rawl.*[Tt]emplate|Raw Crawl/,
    );
  });

  // ── Crawl coverage + KG fields (bead yoy) ────────────────────────────────

  test('extracts crawlSummary from surfer.crawl nodeExecution output', async () => {
    setupHappyPath({ isLocalhost: false });
    const result = await triggerCrawlHandler(publicInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);

    expect(body.crawlSummary).toBeDefined();
    expect(body.crawlSummary).toMatchObject({
      pagesDiscovered: 7,
      actionsExecuted: 5,
      stepsTaken: 3,
      transitionsRecorded: 6,
      knowledgeGraphStates: 7,
      success: true,
    });
  });

  test('extracts knowledgeGraph from knowledge_graph.import nodeExecution output', async () => {
    setupHappyPath({ isLocalhost: false });
    const result = await triggerCrawlHandler(publicInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);

    expect(body.knowledgeGraph).toBeDefined();
    expect(body.knowledgeGraph).toMatchObject({
      imported: true,          // derived: !skipped
      skipped: false,
      edgesImported: 12,
      statesImported: 7,
      knowledgeGraphId: 'kg-uuid-xyz',
    });
  });

  test('knowledgeGraph.imported is false and reason is "no_environment" when KG import skipped', async () => {
    setupHappyPath({ isLocalhost: false });
    const skippedKg = {
      ...COMPLETED_EXECUTION,
      nodeExecutions: COMPLETED_EXECUTION.nodeExecutions.map(n =>
        n.nodeType === 'knowledge_graph.import'
          ? { ...n, outputData: { skipped: true, reason: 'no_environment', edgesImported: 0, statesImported: 0, knowledgeGraphId: '', importErrors: [] } }
          : n,
      ),
    };
    mockPoll.mockResolvedValue(skippedKg);

    const result = await triggerCrawlHandler(publicInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);

    expect(body.knowledgeGraph.imported).toBe(false);
    expect(body.knowledgeGraph.skipped).toBe(true);
    expect(body.knowledgeGraph.reason).toBe('no_environment');
    expect(body.knowledgeGraph.statesImported).toBe(0);
  });

  test('older graph shape (no surfer.crawl node) does NOT crash — crawlSummary absent', async () => {
    setupHappyPath({ isLocalhost: false });
    const olderShape = {
      ...COMPLETED_EXECUTION,
      nodeExecutions: COMPLETED_EXECUTION.nodeExecutions.filter(n => n.nodeType !== 'surfer.crawl'),
    };
    mockPoll.mockResolvedValue(olderShape);

    const result = await triggerCrawlHandler(publicInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);

    expect(body.executionId).toBe('crawl-exec-uuid-1');
    expect(body.crawlSummary).toBeUndefined();
  });

  test('older graph shape (no knowledge_graph.import node) does NOT crash — knowledgeGraph absent', async () => {
    setupHappyPath({ isLocalhost: false });
    const olderShape = {
      ...COMPLETED_EXECUTION,
      nodeExecutions: COMPLETED_EXECUTION.nodeExecutions.filter(n => n.nodeType !== 'knowledge_graph.import'),
    };
    mockPoll.mockResolvedValue(olderShape);

    const result = await triggerCrawlHandler(publicInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);

    expect(body.executionId).toBe('crawl-exec-uuid-1');
    expect(body.knowledgeGraph).toBeUndefined();
  });

  // ── Bead 0bq: progress-notification race safety ────────────────────────────
  //
  // Mirror of the same four invariants verified in testPageChangesHandler.test.ts.
  // Both handlers share the identical circuit-breaker + inside-onUpdate final-
  // progress pattern; symmetrical coverage keeps one handler from drifting.

  describe('bead 1om: pre-flight + health validation', () => {
    test('pre-flight probe fails → LocalServerUnreachable; no provision/execute', async () => {
      setupHappyPath({ isLocalhost: true });
      mockProbeLocalPort.mockResolvedValueOnce({
        reachable: false, code: 'ECONNREFUSED', detail: 'refused', elapsedMs: 2,
      });

      const result = await triggerCrawlHandler(localhostInput, defaultContext);

      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text!);
      expect(body.error).toBe('LocalServerUnreachable');
      expect(mockProvision).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    test('tunnel health probe fails → TunnelTrafficBlocked; no execute', async () => {
      setupHappyPath({ isLocalhost: true });
      mockProbeTunnelHealth.mockResolvedValueOnce({
        healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_8012',
        status: 502, elapsedMs: 50,
      });

      const result = await triggerCrawlHandler(localhostInput, defaultContext);

      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text!);
      expect(body.error).toBe('TunnelTrafficBlocked');
      expect(body.detail.ngrokErrorCode).toBe('ERR_NGROK_8012');
      expect(mockProvision).toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
      // ERR_NGROK_8012 = the tunnel is ALIVE and its upstream refused. Keep it:
      // a teardown plus the re-provision it forces costs two billed hours, and
      // the next call reuses this tunnel for free once the dev server is back.
      expect(mockMarkTunnelDead).not.toHaveBeenCalled();
      expect(mockStopTunnel).not.toHaveBeenCalled();
    });

    test('health probe fails with NETWORK_ERROR → tunnel left completely alone', async () => {
      setupHappyPath({ isLocalhost: true });
      // What every real probe failure looks like on this edge (bead kmzb): undici
      // gets an HTTP/2 GOAWAY instead of ngrok's interstitial, so no code at all.
      // Indistinguishable from the transient flake of bead k6yq — so never a
      // teardown trigger.
      mockProbeTunnelHealth.mockResolvedValueOnce({
        healthy: false, code: 'NETWORK_ERROR',
        detail: 'fetch failed (UND_ERR_SOCKET: HTTP/2 "GOAWAY" frame received with code 0)',
        elapsedMs: 800,
      });

      const result = await triggerCrawlHandler(localhostInput, defaultContext);

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text!).error).toBe('TunnelTrafficBlocked');
      expect(mockMarkTunnelDead).not.toHaveBeenCalled();
      expect(mockStopTunnel).not.toHaveBeenCalled();
    });

    test('health probe reports ERR_NGROK_3200 → endpoint proven gone, evicted', async () => {
      setupHappyPath({ isLocalhost: true });
      mockProbeTunnelHealth.mockResolvedValueOnce({
        healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_3200',
        status: 404, elapsedMs: 50,
      });

      const result = await triggerCrawlHandler(localhostInput, defaultContext);

      expect(result.isError).toBe(true);
      // The one code that proves the endpoint no longer exists: evicting costs
      // nothing (it is already gone) and leaving it lets every session re-borrow
      // the corpse for the rest of the freshness window (bead k34o).
      // §2.3: markTunnelDead dropped its `port` parameter — no longer port-scoped.
      expect(mockMarkTunnelDead).toHaveBeenCalledWith(expect.any(String));
      expect(mockStopTunnel).not.toHaveBeenCalled();
    });

    test('public URL path: neither probe runs', async () => {
      setupHappyPath({ isLocalhost: false });

      await triggerCrawlHandler(publicInput, defaultContext);

      expect(mockProbeLocalPort).not.toHaveBeenCalled();
      expect(mockProbeTunnelHealth).not.toHaveBeenCalled();
    });
  });

  describe('bead 0bq: progress-race safety', () => {
    test('no progressCallback call happens AFTER pollExecution resolves', async () => {
      setupHappyPath({ isLocalhost: false });

      const progressCallback = jest.fn<() => Promise<void>>().mockResolvedValue();
      let pollResolvedAt: number | null = null;
      let lastProgressAt: number | null = null;

      progressCallback.mockImplementation(async () => {
        lastProgressAt = Date.now();
      });
      mockPoll.mockImplementation(async (_uuid: any, onUpdate: any) => {
        if (onUpdate) {
          await onUpdate({
            uuid: 'crawl-exec-uuid-1', status: 'running', nodeExecutions: [],
            state: { outcome: '', stepsTaken: 1 },
          } as any);
          await onUpdate(COMPLETED_EXECUTION as any);
        }
        pollResolvedAt = Date.now();
        await new Promise(r => setTimeout(r, 5));
        return COMPLETED_EXECUTION;
      });

      await triggerCrawlHandler(publicInput, defaultContext, progressCallback);

      expect(progressCallback).toHaveBeenCalled();
      expect(pollResolvedAt).not.toBeNull();
      expect(lastProgressAt).not.toBeNull();
      expect(lastProgressAt! <= pollResolvedAt!).toBe(true);
    });

    test('final progress reaches total inside onUpdate (UX invariant preserved)', async () => {
      setupHappyPath({ isLocalhost: false });

      const progressEvents: Array<{ progress: number; total: number; message?: string }> = [];
      const progressCallback = jest.fn<(u: any) => Promise<void>>().mockImplementation(async (u) => {
        progressEvents.push(u);
      });
      mockPoll.mockImplementation(async (_uuid: any, onUpdate: any) => {
        if (onUpdate) {
          await onUpdate({ uuid: 'crawl-exec-uuid-1', status: 'running', nodeExecutions: [], state: { stepsTaken: 1 } } as any);
          await onUpdate(COMPLETED_EXECUTION as any);
        }
        return COMPLETED_EXECUTION;
      });

      await triggerCrawlHandler(publicInput, defaultContext, progressCallback);

      const last = progressEvents[progressEvents.length - 1];
      expect(last.progress).toBe(last.total);
      expect(last.message).toMatch(/Crawl completed|Crawl failed|Crawl cancelled/i);
    });

    test('circuit breaker: progressCallback throws once → subsequent calls suppressed', async () => {
      setupHappyPath({ isLocalhost: false });

      let callCount = 0;
      const progressCallback = jest.fn<() => Promise<void>>().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('client rejected progressToken');
      });

      mockPoll.mockImplementation(async (_uuid: any, onUpdate: any) => {
        if (onUpdate) {
          await onUpdate({ uuid: 'crawl-exec-uuid-1', status: 'running', nodeExecutions: [], state: { stepsTaken: 1 } } as any);
          await onUpdate({ uuid: 'crawl-exec-uuid-1', status: 'running', nodeExecutions: [], state: { stepsTaken: 2 } } as any);
          await onUpdate(COMPLETED_EXECUTION as any);
        }
        return COMPLETED_EXECUTION;
      });

      // Must not throw even though progressCallback threw mid-flow.
      const result = await triggerCrawlHandler(publicInput, defaultContext, progressCallback);
      expect(result.content).toBeDefined();

      // After the first throw (call 1 — "Locating crawl workflow template..."),
      // the breaker trips and no further callbacks fire for this request.
      expect(progressCallback).toHaveBeenCalledTimes(1);
    });

    test('progressCallback throw never aborts the handler — tool response still returned', async () => {
      setupHappyPath({ isLocalhost: false });

      const progressCallback = jest.fn<() => Promise<void>>().mockRejectedValue(
        new Error('transport closed mid-progress'),
      );

      const result = await triggerCrawlHandler(publicInput, defaultContext, progressCallback);

      // Handler must complete cleanly despite every progressCallback throwing.
      expect(result.content).toBeDefined();
      const body = JSON.parse(result.content[0].text!);
      expect(body.executionId).toBe('crawl-exec-uuid-1');
      expect(body.status).toBe('completed');
    });
  });

  // ── Bead kbo9: bounded retry on transient backend errors (mirror of kbxy) ──
  describe('transient-error retry (bead kbo9)', () => {
    const TRANSIENT_FINAL = {
      ...COMPLETED_EXECUTION,
      status: 'failed',
      state: {
        outcome: 'fail',
        success: false,
        stepsTaken: 0,
        error: 'Invalid JSON: EOF while parsing a value at line 1 column 0',
      },
      errorMessage: '',
    };

    test('transient error on first crawl attempt → retries → succeeds on attempt 2', async () => {
      setupHappyPath({ isLocalhost: false });
      mockPoll
        .mockResolvedValueOnce(TRANSIENT_FINAL)
        .mockResolvedValueOnce(COMPLETED_EXECUTION);

      const result = await triggerCrawlHandler(publicInput, defaultContext);
      const body = JSON.parse(result.content[0].text!);

      expect(mockExecute.mock.calls.length).toBe(2);
      expect(mockPoll.mock.calls.length).toBe(2);
      // Attempt 2's executionUuid is what reaches the response
      expect(body.status).toBe('completed');
    });

    test('non-transient error → NO retry, returns first attempt', async () => {
      setupHappyPath({ isLocalhost: false });
      const NON_TRANSIENT = {
        ...COMPLETED_EXECUTION,
        status: 'completed',
        state: {
          outcome: 'fail',
          success: false,
          stepsTaken: 5,
          error: 'crawl bailed: max-pages reached without exit condition',
        },
      };
      mockPoll.mockResolvedValue(NON_TRANSIENT);

      await triggerCrawlHandler(publicInput, defaultContext);
      expect(mockExecute.mock.calls.length).toBe(1);
      expect(mockPoll.mock.calls.length).toBe(1);
    });

    test('persistent transient → exhausts default 1 retry, surfaces failure', async () => {
      setupHappyPath({ isLocalhost: false });
      mockPoll.mockResolvedValue(TRANSIENT_FINAL);

      await triggerCrawlHandler(publicInput, defaultContext);
      // Default MAX_RETRIES = 1 → 2 total attempts
      expect(mockExecute.mock.calls.length).toBe(2);
      expect(mockPoll.mock.calls.length).toBe(2);
    });
  });

  // ── Bead 56kd.7: cancellation via the request/transport signal ─────────────
  // Cancellation must be driven by context.signal (the MCP request/transport
  // lifecycle), NOT process.stdin. Under the stateless HTTP transport stdin is
  // not the transport, so the old stdin 'close' listener never fired — a dropped
  // client kept polling for up to ~10 min. Wiring to context.signal cancels the
  // poll immediately, exactly like check_app_in_browser (bead 56kd.5).
  describe('lifecycle cancellation via request signal (bead 56kd.7)', () => {
    test('aborting the request signal cancels the poll (wired through to pollExecution)', async () => {
      setupHappyPath({ isLocalhost: false });
      let pollSignal: AbortSignal | undefined;
      mockPoll.mockImplementation((async (_uuid: string, _onUpdate: any, signal: AbortSignal) => {
        pollSignal = signal;
        return await new Promise((_resolve, reject) => {
          const fail = () => reject(new Error('poll cancelled'));
          if (signal?.aborted) return fail();
          signal?.addEventListener('abort', fail, { once: true });
        });
      }) as any);

      const controller = new AbortController();
      const ctx: ToolContext = { requestId: 'crawl-abort-1', timestamp: new Date(), signal: controller.signal };
      const p = triggerCrawlHandler(publicInput, ctx);
      await new Promise((r) => setImmediate(r)); // let the handler reach pollExecution
      controller.abort();

      await expect(p).rejects.toThrow();
      expect(pollSignal).toBeDefined();
      expect(pollSignal!.aborted).toBe(true);
    });

    test('an already-aborted request signal cancels immediately', async () => {
      setupHappyPath({ isLocalhost: false });
      let pollSignal: AbortSignal | undefined;
      mockPoll.mockImplementation((async (_uuid: string, _onUpdate: any, signal: AbortSignal) => {
        pollSignal = signal;
        if (signal?.aborted) throw new Error('poll cancelled');
        return COMPLETED_EXECUTION;
      }) as any);

      const controller = new AbortController();
      controller.abort();
      const ctx: ToolContext = { requestId: 'crawl-abort-2', timestamp: new Date(), signal: controller.signal };

      await expect(triggerCrawlHandler(publicInput, ctx)).rejects.toThrow();
      expect(pollSignal!.aborted).toBe(true);
    });

    test('no request signal (stdio without cancellation) → handler still completes', async () => {
      setupHappyPath({ isLocalhost: false });
      const ctx: ToolContext = { requestId: 'crawl-no-signal', timestamp: new Date() }; // no signal
      const result = await triggerCrawlHandler(publicInput, ctx);
      expect(JSON.parse(result.content[0].text!).executionId).toBe('crawl-exec-uuid-1');
    });
  });

  // §5.5 "trigger_crawl lock-wiring parity" test — trigger_crawl polls
  // identically to check_app_in_browser/probe_page (verified by reading the
  // handler, §2.3/§4 of the architecture doc), so it gets the SAME
  // acquirePortRoute/releasePortRoute wiring — NOT the run_test_suite
  // dedicated-tunnel carve-out. A future refactor that accidentally moved
  // trigger_crawl onto the fire-and-forget exception path would fail this
  // structural assertion loudly.
  describe('shared port-route lock wiring (§2.4, parity with check_app_in_browser/probe_page)', () => {
    test('acquirePortRoute fires after ensureTunnel and BEFORE probeTunnelHealth; releasePortRoute fires in the finally', async () => {
      setupHappyPath({ isLocalhost: true });
      const order: string[] = [];
      mockEnsureTunnel.mockImplementation(async () => {
        order.push('ensureTunnel');
        return {
          originalUrl: 'http://localhost:3000',
          isLocalhost: true,
          tunnelId: PROVISION_RESPONSE.tunnelId,
          targetUrl: `https://${PROVISION_RESPONSE.tunnelId}.ngrok.debugg.ai/`,
        };
      });
      mockAcquirePortRoute.mockImplementation(async (ctx: any) => {
        order.push('acquirePortRoute');
        return { ...ctx, routeLock: { release: () => order.push('releasePortRoute') } };
      });
      mockReleasePortRoute.mockImplementation((ctx: any) => ctx.routeLock?.release());
      mockProbeTunnelHealth.mockImplementation(async () => {
        order.push('probeTunnelHealth');
        return { healthy: true, status: 200, elapsedMs: 1 };
      });
      mockExecute.mockImplementation(async () => { order.push('execute'); return EXECUTE_RESPONSE; });

      await triggerCrawlHandler(localhostInput, defaultContext);

      expect(order).toEqual([
        'ensureTunnel', 'acquirePortRoute', 'probeTunnelHealth', 'execute', 'releasePortRoute',
      ]);
      expect(mockAcquirePortRoute).toHaveBeenCalledTimes(1);
      expect(mockReleasePortRoute).toHaveBeenCalledTimes(1);
    });

    test('releasePortRoute still fires when the handler errors out after acquiring the route', async () => {
      setupHappyPath({ isLocalhost: true });
      mockAcquirePortRoute.mockImplementation(async (ctx: any) => ({ ...ctx, routeLock: { release: jest.fn() } }));
      mockExecute.mockRejectedValue(new Error('backend exploded'));

      await expect(triggerCrawlHandler(localhostInput, defaultContext)).rejects.toThrow();

      expect(mockAcquirePortRoute).toHaveBeenCalledTimes(1);
      expect(mockReleasePortRoute).toHaveBeenCalledTimes(1);
    });

    test('public URL: the handler never even calls acquirePortRoute (no tunnel branch entered)', async () => {
      setupHappyPath({ isLocalhost: false });
      const result = await triggerCrawlHandler(publicInput, defaultContext);

      expect(result.isError).toBeFalsy();
      expect(mockAcquirePortRoute).not.toHaveBeenCalled();
      // releasePortRoute is still safe to call unconditionally in the finally
      // (no-op on a ctx that never got a routeLock) — it fires regardless.
      expect(mockReleasePortRoute).toHaveBeenCalledTimes(1);
    });
  });
});
