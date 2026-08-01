/**
 * probePageHandler tests — Phase 2.1 of /feature-lifecycle probe-page.
 *
 * Mirrors the mock scaffolding from triggerCrawlHandler.test.ts (closest
 * analog: tunnel + cached template + execute + poll + format response).
 *
 * MUST FAIL until 4.1 ships — stub throws.
 */

import { jest } from '@jest/globals';
import { ToolContext, ProbePageInput } from '../../types/index.js';

const mockProvision = jest.fn<() => Promise<any>>();
const mockFindTemplateBySlug = jest.fn<(kw: string) => Promise<any>>();
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
// §2.4/§4: mirrors the real acquirePortRoute's no-op contract (public URL /
// no tunnelId → unchanged ctx). Named so multi-port-batch tests can assert
// how many times/with what targets the lock was acquired.
const mockRouteLockRelease = jest.fn();
const mockAcquirePortRoute = jest.fn(async (ctx: any) =>
  ctx.isLocalhost && ctx.tunnelId ? { ...ctx, routeLock: { release: mockRouteLockRelease } } : ctx);
const mockReleasePortRoute = jest.fn();

const mockProbeLocalPort = jest.fn<(port: number) => Promise<any>>();
const mockProbeTunnelHealth = jest.fn<(url: string) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    tunnels: { provision: mockProvision, provisionWithRetry: mockProvision },
    workflows: {
      findTemplateBySlug: mockFindTemplateBySlug,
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
  acquirePortRoute: mockAcquirePortRoute,
  releasePortRoute: mockReleasePortRoute,
  sanitizeResponseUrls: mockSanitizeResponseUrls,
  touchTunnelById: mockTouchTunnelById,
}));

jest.unstable_mockModule('../../utils/localReachability.js', () => ({
  probeLocalPort: mockProbeLocalPort,
  probeTunnelHealth: mockProbeTunnelHealth,
}));

// A failed health probe may evict the tunnel (only when the endpoint is PROVEN
// gone — see utils/tunnelDisposition.ts). Mocked so the suite never touches a
// real tunnel, and named so tests can assert on what the handler did NOT do.
const mockStopTunnel = jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any);
const mockMarkTunnelDead = jest.fn<(...a: any[]) => Promise<void>>().mockResolvedValue(undefined as any);
jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: { stopTunnel: mockStopTunnel, markTunnelDead: mockMarkTunnelDead },
}));

const { probePageHandler } = await import('../../handlers/probePageHandler.js');

const defaultContext: ToolContext = {
  requestId: 'test-request',
  timestamp: new Date(),
};

const TEMPLATE = { uuid: 'tmpl-uuid-page-probe', name: 'Page Probe' };

function setupHappyPath({ isLocalhost = false } = {}) {
  mockInit.mockResolvedValue(undefined);
  mockResolveTargetUrl.mockReturnValue('https://example.com');
  mockBuildContext.mockReturnValue({
    originalUrl: 'https://example.com',
    targetUrl: 'https://example.com',
    isLocalhost,
  });
  mockFindExistingTunnel.mockReturnValue(null);
  mockSanitizeResponseUrls.mockImplementation((val: any) => val);
  mockFindTemplateBySlug.mockResolvedValue(TEMPLATE);
  mockExecute.mockResolvedValue({
    executionUuid: 'exec-uuid-1',
    resolvedEnvironmentId: null,
    resolvedCredentialId: null,
  });
  mockPoll.mockResolvedValue({
    uuid: 'exec-uuid-1',
    status: 'completed',
    durationMs: 4200,
    nodeExecutions: [
      {
        nodeType: 'browser.capture',
        executionOrder: 1,
        status: 'success',
        outputData: {
          // Backend v2 (post-154e1e69) shape: capturedUrl + surferPageUuid;
          // network_summary pre-aggregated; console_slice in {text, level,
          // location, timestamp} shape. Screenshot lives on SurferPage row.
          capturedUrl: 'https://example.com',
          statusCode: 200,
          title: 'Example Domain',
          loadTimeMs: 1240,
          consoleSlice: [],
          networkSummary: [],
          surferPageUuid: 'page-uuid-1',
        },
      },
    ],
    state: { outcome: 'completed', success: true, stepsTaken: 0, error: '' },
    browserSession: {
      uuid: 'bs-1',
      status: 'COMPLETED',
      harUrl: null,
      consoleLogUrl: null,
      recordingUrl: null,
      harStatus: 'queued_for_download',
      consoleLogStatus: 'queued_for_download',
      harRedactionStatus: null,
      consoleLogRedactionStatus: null,
    },
  });
  if (isLocalhost) {
    mockProbeLocalPort.mockResolvedValue({ reachable: true, code: 'OK', elapsedMs: 5 });
    mockProbeTunnelHealth.mockResolvedValue({ healthy: true, code: 'OK', status: 200, elapsedMs: 50 });
  }
}

const singleInput: ProbePageInput = {
  targets: [{ url: 'https://example.com', waitForLoadState: 'load', timeoutMs: 10000 }],
  includeHtml: false,
  captureScreenshots: true,
} as any;

describe('probePageHandler — happy path', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const { invalidateTemplateCache } = await import('../../utils/handlerCaches.js');
    invalidateTemplateCache();
  });

  test('resolves the page-probe template by its stable slug (flow/tools/probe) — no fuzzy name (bead 56kd.8)', async () => {
    setupHappyPath();
    await probePageHandler(singleInput, defaultContext);
    expect(mockFindTemplateBySlug).toHaveBeenCalledWith('flow/tools/probe');
  });

  test('a backend RENAME of the page-probe template breaks nothing (slug is the identity)', async () => {
    setupHappyPath();
    // Backend returns the template under a totally different display name; the
    // handler dispatched by slug, so it still gets a uuid and proceeds.
    mockFindTemplateBySlug.mockResolvedValue({ uuid: 'tmpl-uuid-page-probe', name: 'Totally Renamed' });
    const result = await probePageHandler(singleInput, defaultContext);
    expect(JSON.parse(result.content[0].text!).executionId).toBe('exec-uuid-1');
  });

  test('returns response with executionId, durationMs, results[]', async () => {
    setupHappyPath();
    const result = await probePageHandler(singleInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);
    expect(body.executionId).toBe('exec-uuid-1');
    expect(typeof body.durationMs).toBe('number');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(1);
  });

  test('result entry contains url, finalUrl, statusCode, title, loadTimeMs', async () => {
    setupHappyPath();
    const result = await probePageHandler(singleInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);
    expect(body.results[0]).toMatchObject({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      statusCode: 200,
      title: 'Example Domain',
      loadTimeMs: 1240,
    });
  });

  test('result entry has consoleErrors[] and networkSummary[] (always arrays, possibly empty)', async () => {
    setupHappyPath();
    const result = await probePageHandler(singleInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);
    expect(Array.isArray(body.results[0].consoleErrors)).toBe(true);
    expect(Array.isArray(body.results[0].networkSummary)).toBe(true);
  });

  test('browserSession passthrough when backend returns it (parity with check_app + crawl)', async () => {
    setupHappyPath();
    const result = await probePageHandler(singleInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);
    expect(body.browserSession).toBeDefined();
    expect(body.browserSession.harStatus).toBe('queued_for_download');
  });

  test('result exposes surferPageUuid so callers can fetch the screenshot from the SurferPage row', async () => {
    // Backend v2 (post-154e1e69): screenshots live on the SurferPage row
    // referenced by surfer_page_uuid, NOT inline as screenshotB64. The
    // tool's `captureScreenshots` flag tells the backend to populate the
    // SurferPage's screenshot_url; callers then GET that URL when they
    // want the bytes.
    setupHappyPath();
    const result = await probePageHandler(singleInput, defaultContext);
    const body = JSON.parse(result.content[0].text!);
    expect(body.results[0].surferPageUuid).toBe('page-uuid-1');
    // No inline image content block in v1 — caller fetches via SurferPage.
    const images = result.content.filter((b: any) => b.type === 'image');
    expect(images).toHaveLength(0);
  });

  test('captureScreenshots: false → still no image content blocks (v1: never inline)', async () => {
    setupHappyPath();
    const result = await probePageHandler(
      { ...singleInput, captureScreenshots: false } as any,
      defaultContext,
    );
    const images = result.content.filter((b: any) => b.type === 'image');
    expect(images).toHaveLength(0);
  });
});

describe('probePageHandler — batch behavior', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const { invalidateTemplateCache } = await import('../../utils/handlerCaches.js');
    invalidateTemplateCache();
  });

  test('5-target batch returns 5 results in input order (1:1 mapping)', async () => {
    setupHappyPath();
    const targets = [
      { url: 'https://example.com/a' },
      { url: 'https://example.com/b' },
      { url: 'https://example.com/c' },
      { url: 'https://example.com/d' },
      { url: 'https://example.com/e' },
    ];
    mockPoll.mockResolvedValue({
      uuid: 'exec-batch',
      status: 'completed',
      durationMs: 8000,
      nodeExecutions: targets.map((t, i) => ({
        nodeType: 'browser.capture',
        executionOrder: i + 1,
        status: 'success',
        outputData: {
          // v2 shape: capturedUrl + networkSummary (pre-aggregated)
          capturedUrl: t.url, statusCode: 200, title: `T${i}`, loadTimeMs: 800,
          consoleSlice: [], networkSummary: [],
          surferPageUuid: `page-uuid-${i}`,
        },
      })),
      state: { outcome: 'completed', success: true, stepsTaken: 0, error: '' },
    });

    const result = await probePageHandler(
      { targets, includeHtml: false, captureScreenshots: true } as any,
      defaultContext,
    );
    const body = JSON.parse(result.content[0].text!);
    expect(body.results).toHaveLength(5);
    expect(body.results.map((r: any) => r.url)).toEqual(targets.map(t => t.url));
  });

  test('per-URL error: one bad target does not fail the batch', async () => {
    setupHappyPath();
    mockPoll.mockResolvedValue({
      uuid: 'exec-mixed',
      status: 'completed',
      durationMs: 5000,
      nodeExecutions: [
        {
          nodeType: 'browser.capture', executionOrder: 1, status: 'success',
          outputData: {
            capturedUrl: 'https://example.com/a',
            statusCode: 200, title: 'A', loadTimeMs: 800, consoleSlice: [], networkSummary: [],
          },
        },
        {
          nodeType: 'browser.capture', executionOrder: 2, status: 'failed',
          outputData: {
            url: 'https://example.com/b', error: 'navigation timeout exceeded 10000ms',
          },
        },
      ],
      state: { outcome: 'completed', success: true, stepsTaken: 0, error: '' },
    });
    const result = await probePageHandler(
      { targets: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }] } as any,
      defaultContext,
    );
    const body = JSON.parse(result.content[0].text!);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].error).toBeUndefined();
    expect(body.results[1].error).toContain('timeout');
  });
});

// §4 multi-port batch decision + §5.6 new tests: single-port batches (incl.
// the existing all-public-URL batch above) dispatch exactly as before — one
// repoint, one backend execution. Cross-port batches decompose into one
// sequential acquirePortRoute → executeWorkflow(subset) → poll →
// releasePortRoute cycle PER PORT GROUP, merging results back into the
// caller's original target order. All localhost targets in these tests
// resolve to the SAME session tunnelId/hostname (session-tid) — exactly the
// hostname-sharing scenario that makes bead debugg_ai_mcp-6cfv.6's
// cross-attribution bug reachable.
describe('probePageHandler — multi-port batch decomposition (§4)', () => {
  const SESSION_TUNNEL_ID = 'session-tid';

  beforeEach(async () => {
    jest.clearAllMocks();
    const { invalidateTemplateCache } = await import('../../utils/handlerCaches.js');
    invalidateTemplateCache();

    mockInit.mockResolvedValue(undefined);
    mockFindTemplateBySlug.mockResolvedValue(TEMPLATE);
    mockProbeLocalPort.mockResolvedValue({ reachable: true, code: 'OK', elapsedMs: 5 });
    mockProbeTunnelHealth.mockResolvedValue({ healthy: true, code: 'OK', status: 200, elapsedMs: 50 });
    mockProvision.mockResolvedValue({ tunnelKey: 'key', tunnelId: SESSION_TUNNEL_ID, keyId: 'kid' });

    // Every localhost target in these tests shares ONE session tunnel —
    // findExistingTunnel never fires (mirrors the first pre-flight pass of a
    // fresh session), ensureTunnel always attaches the SAME tunnelId/hostname
    // regardless of which port the caller asked for, only the retargeted
    // path differs (§2.1: one tunnel per session, not per port).
    mockFindExistingTunnel.mockReturnValue(null);
    mockBuildContext.mockImplementation((url: string) => ({
      originalUrl: url,
      targetUrl: url,
      isLocalhost: url.includes('localhost') || url.includes('127.0.0.1'),
    }));
    mockEnsureTunnel.mockImplementation(async (ctx: any) => ({
      ...ctx,
      tunnelId: SESSION_TUNNEL_ID,
      targetUrl: ctx.originalUrl.replace(/^https?:\/\/[^/]+/, `https://${SESSION_TUNNEL_ID}.ngrok.debugg.ai`),
    }));
  });

  function captureNode(order: number, overrides: Record<string, any> = {}) {
    return {
      nodeType: 'browser.capture',
      executionOrder: order,
      status: 'success',
      outputData: {
        capturedUrl: 'http://placeholder', statusCode: 200, title: 'T', loadTimeMs: 100,
        consoleSlice: [], networkSummary: [],
        ...overrides,
      },
    };
  }

  test('same-port localhost batch: ONE repoint, ONE backend execution (unchanged from before §4)', async () => {
    mockExecute.mockResolvedValue({ executionUuid: 'exec-same-port', resolvedEnvironmentId: null, resolvedCredentialId: null });
    mockPoll.mockResolvedValue({
      uuid: 'exec-same-port', status: 'completed', durationMs: 900,
      nodeExecutions: [
        captureNode(1, { capturedUrl: `https://${SESSION_TUNNEL_ID}.ngrok.debugg.ai/a` }),
        captureNode(2, { capturedUrl: `https://${SESSION_TUNNEL_ID}.ngrok.debugg.ai/b` }),
      ],
      state: { outcome: 'completed', success: true, stepsTaken: 0, error: '' },
    });

    const result = await probePageHandler(
      { targets: [{ url: 'http://localhost:3000/a' }, { url: 'http://localhost:3000/b' }] } as any,
      defaultContext,
    );

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockAcquirePortRoute).toHaveBeenCalledTimes(1);
    expect(mockReleasePortRoute).toHaveBeenCalledTimes(1);
    const body = JSON.parse(result.content[0].text!);
    expect(body.results).toHaveLength(2);
    expect(body.executionId).toBe('exec-same-port');
    expect(body.executionIds).toBeUndefined();
  });

  test('cross-port batch: decomposes into ONE sequential dispatch per port group, merged in original order', async () => {
    mockExecute
      .mockResolvedValueOnce({ executionUuid: 'exec-port-3000', resolvedEnvironmentId: null, resolvedCredentialId: null })
      .mockResolvedValueOnce({ executionUuid: 'exec-port-4000', resolvedEnvironmentId: null, resolvedCredentialId: null });
    mockPoll
      .mockResolvedValueOnce({
        uuid: 'exec-port-3000', status: 'completed', durationMs: 500,
        nodeExecutions: [captureNode(1, { capturedUrl: `https://${SESSION_TUNNEL_ID}.ngrok.debugg.ai/a`, title: 'PortA' })],
        state: { outcome: 'completed', success: true, stepsTaken: 0, error: '' },
      })
      .mockResolvedValueOnce({
        uuid: 'exec-port-4000', status: 'completed', durationMs: 600,
        nodeExecutions: [captureNode(1, { capturedUrl: `https://${SESSION_TUNNEL_ID}.ngrok.debugg.ai/b`, title: 'PortB' })],
        state: { outcome: 'completed', success: true, stepsTaken: 0, error: '' },
      });

    const result = await probePageHandler(
      {
        targets: [
          { url: 'http://localhost:3000/a' },
          { url: 'http://localhost:4000/b' },
        ],
      } as any,
      defaultContext,
    );

    // TWO backend round-trips, one per port group, dispatched sequentially.
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockPoll).toHaveBeenCalledTimes(2);
    // TWO separate acquire/release cycles — one per port group — not one for
    // the whole batch.
    expect(mockAcquirePortRoute).toHaveBeenCalledTimes(2);
    expect(mockReleasePortRoute).toHaveBeenCalledTimes(2);

    const body = JSON.parse(result.content[0].text!);
    expect(body.results).toHaveLength(2);
    // Results merged back into the CALLER'S original order, not dispatch order.
    expect(body.results[0].url).toBe('http://localhost:3000/a');
    expect(body.results[0].title).toBe('PortA');
    expect(body.results[1].url).toBe('http://localhost:4000/b');
    expect(body.results[1].title).toBe('PortB');
    // Multi-group batches surface every execution id additively, without
    // changing what single-group callers already parse (`executionId`).
    expect(body.executionId).toBe('exec-port-3000');
    expect(body.executionIds).toEqual(['exec-port-3000', 'exec-port-4000']);
  });

  test('cross-port batch: a failing port group does not corrupt the OTHER group\'s results', async () => {
    mockExecute
      .mockResolvedValueOnce({ executionUuid: 'exec-ok', resolvedEnvironmentId: null, resolvedCredentialId: null })
      .mockRejectedValueOnce(new Error('backend exploded for port 4000'));
    mockPoll.mockResolvedValueOnce({
      uuid: 'exec-ok', status: 'completed', durationMs: 500,
      nodeExecutions: [captureNode(1, { capturedUrl: `https://${SESSION_TUNNEL_ID}.ngrok.debugg.ai/a` })],
      state: { outcome: 'completed', success: true, stepsTaken: 0, error: '' },
    });

    await expect(probePageHandler(
      { targets: [{ url: 'http://localhost:3000/a' }, { url: 'http://localhost:4000/b' }] } as any,
      defaultContext,
    )).rejects.toThrow();

    // The first group's route was acquired AND released even though the
    // second group blew up later — no leaked lock on the failure path.
    expect(mockAcquirePortRoute).toHaveBeenCalledTimes(2);
    expect(mockReleasePortRoute).toHaveBeenCalledTimes(2);
  });

  // Bead debugg_ai_mcp-6cfv.6: the cross-attribution regression test. Both
  // targets' captured data contain the literal SAME shared session hostname
  // (both localhost targets share ONE session tunnel/hostname under §2.1) —
  // the exact condition that made the old whole-payload sanitize loop rewrite
  // whichever target sanitized first onto EVERY remaining occurrence,
  // including the other target's own (correct) one.
  test('bead debugg_ai_mcp-6cfv.6: each result is sanitized against ITS OWN target origin, not cross-attributed', async () => {
    // A realistic sanitize: strip the shared tunnel hostname down to the
    // CALLER'S OWN localhost origin — exactly utils/urlParser.ts's
    // replaceTunnelUrls, parameterized per-call by ctx.originalUrl.
    mockSanitizeResponseUrls.mockImplementation((value: any, ctx: any) => {
      if (!ctx.isLocalhost) return value;
      const origin = new URL(ctx.originalUrl).origin;
      return JSON.parse(
        JSON.stringify(value).replace(/https?:\/\/[^\s"/]+\.ngrok\.debugg\.ai/g, origin),
      );
    });

    mockExecute
      .mockResolvedValueOnce({ executionUuid: 'exec-port-3000', resolvedEnvironmentId: null, resolvedCredentialId: null })
      .mockResolvedValueOnce({ executionUuid: 'exec-port-4000', resolvedEnvironmentId: null, resolvedCredentialId: null });
    mockPoll
      .mockResolvedValueOnce({
        uuid: 'exec-port-3000', status: 'completed', durationMs: 500,
        nodeExecutions: [captureNode(1, {
          capturedUrl: `https://${SESSION_TUNNEL_ID}.ngrok.debugg.ai/a`,
          // The tunnel hostname leaking into agent-authored content (title).
          title: `Loaded https://${SESSION_TUNNEL_ID}.ngrok.debugg.ai/a`,
        })],
        state: { outcome: 'completed', success: true, stepsTaken: 0, error: '' },
      })
      .mockResolvedValueOnce({
        uuid: 'exec-port-4000', status: 'completed', durationMs: 600,
        nodeExecutions: [captureNode(1, {
          capturedUrl: `https://${SESSION_TUNNEL_ID}.ngrok.debugg.ai/b`,
          title: `Loaded https://${SESSION_TUNNEL_ID}.ngrok.debugg.ai/b`,
        })],
        state: { outcome: 'completed', success: true, stepsTaken: 0, error: '' },
      });

    const result = await probePageHandler(
      { targets: [{ url: 'http://localhost:3000/a' }, { url: 'http://localhost:4000/b' }] } as any,
      defaultContext,
    );

    const body = JSON.parse(result.content[0].text!);
    // Each result rewritten to ITS OWN target's localhost origin — never the
    // other target's. The pre-fix whole-payload sanitize loop would have let
    // whichever target ran last overwrite BOTH occurrences with its own origin.
    expect(body.results[0].finalUrl).toBe('http://localhost:3000/a');
    expect(body.results[0].title).toBe('Loaded http://localhost:3000/a');
    expect(body.results[1].finalUrl).toBe('http://localhost:4000/b');
    expect(body.results[1].title).toBe('Loaded http://localhost:4000/b');
    // No raw tunnel hostname survives anywhere in the response.
    expect(result.content[0].text).not.toMatch(/ngrok\.debugg\.ai/);
  });
});

describe('probePageHandler — localhost pre-flight', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const { invalidateTemplateCache } = await import('../../utils/handlerCaches.js');
    invalidateTemplateCache();
  });

  test('localhost target with dead port: returns LocalServerUnreachable in <2s', async () => {
    setupHappyPath({ isLocalhost: true });
    mockProbeLocalPort.mockResolvedValue({ reachable: false, code: 'ECONNREFUSED', elapsedMs: 8 });
    mockBuildContext.mockReturnValue({
      originalUrl: 'http://localhost:9999',
      targetUrl: 'http://localhost:9999',
      isLocalhost: true,
    });
    mockResolveTargetUrl.mockReturnValue('http://localhost:9999');
    const t0 = Date.now();
    const result = await probePageHandler(
      { targets: [{ url: 'http://localhost:9999' }] } as any,
      defaultContext,
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text!);
    expect(body.error).toBe('LocalServerUnreachable');
  });

  // ── Tunnel disposition on a failed health probe (utils/tunnelDisposition.ts) ──
  // ngrok bills a 1-hour MINIMUM per tunnel, so a teardown plus the re-provision
  // it forces costs two billed hours. Only a code proving the endpoint is gone
  // may evict; everything else keeps the tunnel for the next call.
  describe('unhealthy tunnel disposition', () => {
    // setupHappyPath re-arms probeTunnelHealth as healthy for the localhost path,
    // so the failing verdict has to be installed after it.
    function localhostProbe(health: Record<string, unknown>) {
      setupHappyPath({ isLocalhost: true });
      mockProbeLocalPort.mockResolvedValue({ reachable: true, code: 'OK', elapsedMs: 5 });
      mockProbeTunnelHealth.mockResolvedValue(health);
      mockBuildContext.mockReturnValue({
        originalUrl: 'http://localhost:3011',
        targetUrl: 'http://localhost:3011',
        isLocalhost: true,
      });
      mockResolveTargetUrl.mockReturnValue('http://localhost:3011');
      mockFindExistingTunnel.mockReturnValue(null);
      mockProvision.mockResolvedValue({ tunnelKey: 'key', tunnelId: 't-live', keyId: 'kid' });
      mockEnsureTunnel.mockResolvedValue({
        originalUrl: 'http://localhost:3011',
        targetUrl: 'https://t-live.ngrok.debugg.ai/',
        tunnelId: 't-live',
        isLocalhost: true,
      });
      return probePageHandler({ targets: [{ url: 'http://localhost:3011' }] } as any, defaultContext);
    }

    test('ERR_NGROK_8012 → tunnel kept (8012 means the tunnel is ALIVE, the upstream refused)', async () => {
      const result = await localhostProbe({
        healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_8012', status: 502, elapsedMs: 60,
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text!).error).toBe('TunnelTrafficBlocked');
      expect(mockMarkTunnelDead).not.toHaveBeenCalled();
      expect(mockStopTunnel).not.toHaveBeenCalled();
    });

    test('NETWORK_ERROR → tunnel kept (bead kmzb: the only shape a real failure takes here)', async () => {
      const result = await localhostProbe({
        healthy: false, code: 'NETWORK_ERROR',
        detail: 'fetch failed (UND_ERR_SOCKET: HTTP/2 "GOAWAY" frame received with code 0)',
        elapsedMs: 800,
      });

      expect(result.isError).toBe(true);
      expect(mockMarkTunnelDead).not.toHaveBeenCalled();
      expect(mockStopTunnel).not.toHaveBeenCalled();
    });

    test('ERR_NGROK_3200 → evicted, because the endpoint is proven gone', async () => {
      const result = await localhostProbe({
        healthy: false, code: 'NGROK_ERROR', ngrokErrorCode: 'ERR_NGROK_3200', status: 404, elapsedMs: 55,
      });

      expect(result.isError).toBe(true);
      // §2.3: markTunnelDead dropped its `port` parameter — no longer port-scoped.
      expect(mockMarkTunnelDead).toHaveBeenCalledWith('t-live');
      expect(mockStopTunnel).not.toHaveBeenCalled();
    });
  });
});

describe('probePageHandler — template not found', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const { invalidateTemplateCache } = await import('../../utils/handlerCaches.js');
    invalidateTemplateCache();
  });

  test('throws clear "PageProbeTemplateNotConfigured"-style error if backend template missing', async () => {
    setupHappyPath();
    mockFindTemplateBySlug.mockResolvedValue(null);
    await expect(probePageHandler(singleInput, defaultContext)).rejects.toThrow(
      /[Pp]age [Pp]robe.*[Tt]emplate|TemplateNotConfigured/,
    );
  });
});

// ── Bead 56kd.7: cancellation via the request/transport signal ───────────────
// Cancellation must be driven by context.signal (the MCP request/transport
// lifecycle), NOT process.stdin. Under the stateless HTTP transport stdin is
// not the transport, so the old stdin 'close' listener never fired — a dropped
// client kept polling for up to ~10 min. Wiring to context.signal cancels the
// poll immediately, exactly like check_app_in_browser (bead 56kd.5).
describe('probePageHandler — lifecycle cancellation via request signal (bead 56kd.7)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const { invalidateTemplateCache } = await import('../../utils/handlerCaches.js');
    invalidateTemplateCache();
  });

  test('aborting the request signal cancels the poll (wired through to pollExecution)', async () => {
    setupHappyPath();
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
    const ctx: ToolContext = { requestId: 'probe-abort-1', timestamp: new Date(), signal: controller.signal };
    const p = probePageHandler(singleInput, ctx);
    await new Promise((r) => setImmediate(r)); // let the handler reach pollExecution
    controller.abort();

    await expect(p).rejects.toThrow();
    expect(pollSignal).toBeDefined();
    expect(pollSignal!.aborted).toBe(true);
  });

  test('an already-aborted request signal cancels immediately', async () => {
    setupHappyPath();
    let pollSignal: AbortSignal | undefined;
    mockPoll.mockImplementation((async (_uuid: string, _onUpdate: any, signal: AbortSignal) => {
      pollSignal = signal;
      if (signal?.aborted) throw new Error('poll cancelled');
      return { uuid: 'exec-uuid-1', status: 'completed', durationMs: 1, nodeExecutions: [] };
    }) as any);

    const controller = new AbortController();
    controller.abort();
    const ctx: ToolContext = { requestId: 'probe-abort-2', timestamp: new Date(), signal: controller.signal };

    await expect(probePageHandler(singleInput, ctx)).rejects.toThrow();
    expect(pollSignal!.aborted).toBe(true);
  });

  test('no request signal (stdio without cancellation) → handler still completes', async () => {
    setupHappyPath();
    const ctx: ToolContext = { requestId: 'probe-no-signal', timestamp: new Date() }; // no signal
    const result = await probePageHandler(singleInput, ctx);
    expect(JSON.parse(result.content[0].text!).executionId).toBe('exec-uuid-1');
  });
});
