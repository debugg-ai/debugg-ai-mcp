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
const mockFindTemplateByName = jest.fn<(kw: string) => Promise<any>>();
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

const mockProbeLocalPort = jest.fn<(port: number) => Promise<any>>();
const mockProbeTunnelHealth = jest.fn<(url: string) => Promise<any>>();

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
  mockFindTemplateByName.mockResolvedValue(TEMPLATE);
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
        nodeType: 'page.capture',
        executionOrder: 1,
        status: 'success',
        outputData: {
          url: 'https://example.com',
          finalUrl: 'https://example.com',
          statusCode: 200,
          title: 'Example Domain',
          loadTimeMs: 1240,
          consoleSlice: [],
          harSlice: [],
          screenshotB64: 'iVBORw0KGgo=',
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

  test('looks up the page-probe template via findTemplateByName("page probe")', async () => {
    setupHappyPath();
    await probePageHandler(singleInput, defaultContext);
    expect(mockFindTemplateByName).toHaveBeenCalledWith('page probe');
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

  test('captureScreenshots: true → image content block per target', async () => {
    setupHappyPath();
    const result = await probePageHandler(singleInput, defaultContext);
    const images = result.content.filter((b: any) => b.type === 'image');
    expect(images).toHaveLength(1);
  });

  test('captureScreenshots: false → no image content blocks', async () => {
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
        nodeType: 'page.capture',
        executionOrder: i + 1,
        status: 'success',
        outputData: {
          url: t.url, finalUrl: t.url, statusCode: 200, title: `T${i}`, loadTimeMs: 800,
          consoleSlice: [], harSlice: [],
          screenshotB64: 'iVBORw0KGgo=',
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
          nodeType: 'page.capture', executionOrder: 1, status: 'success',
          outputData: {
            url: 'https://example.com/a', finalUrl: 'https://example.com/a',
            statusCode: 200, title: 'A', loadTimeMs: 800, consoleSlice: [], harSlice: [],
          },
        },
        {
          nodeType: 'page.capture', executionOrder: 2, status: 'failed',
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
});

describe('probePageHandler — template not found', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const { invalidateTemplateCache } = await import('../../utils/handlerCaches.js');
    invalidateTemplateCache();
  });

  test('throws clear "PageProbeTemplateNotConfigured"-style error if backend template missing', async () => {
    setupHappyPath();
    mockFindTemplateByName.mockResolvedValue(null);
    await expect(probePageHandler(singleInput, defaultContext)).rejects.toThrow(
      /[Pp]age [Pp]robe.*[Tt]emplate|TemplateNotConfigured/,
    );
  });
});
