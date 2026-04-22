/**
 * Tests for triggerCrawlHandler — proof point for bead ew8 + bead 8ji.
 *
 * Structure mirrors testPageChangesHandler.test.ts (same mock scaffolding)
 * but the surface under test calls findTemplateByName('raw crawl') and
 * returns a crawl-shaped response without outcome pass/fail semantics.
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockProvision = jest.fn<() => Promise<any>>();
const mockFindTemplateByName = jest.fn<(kw: string) => Promise<any>>();
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

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    tunnels: { provision: mockProvision },
    workflows: {
      findTemplateByName: mockFindTemplateByName,
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
  sanitizeResponseUrls: mockSanitizeResponseUrls,
  touchTunnelById: mockTouchTunnelById,
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
  mockFindTemplateByName.mockResolvedValue(TEMPLATE);
  mockExecute.mockResolvedValue(EXECUTE_RESPONSE);
  mockPoll.mockResolvedValue(COMPLETED_EXECUTION);
  mockRevokeKey.mockResolvedValue(undefined);

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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('looks up the crawl template via findTemplateByName("raw crawl")', async () => {
    setupHappyPath({ isLocalhost: false });
    await triggerCrawlHandler(publicInput, defaultContext);
    expect(mockFindTemplateByName).toHaveBeenCalledWith('raw crawl');
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

  test('optional contextData fields (projectUuid, headless, timeoutSeconds) are threaded correctly', async () => {
    setupHappyPath({ isLocalhost: false });
    const input = {
      url: 'https://example.com',
      projectUuid: '269532cb-0000-0000-0000-000000000000',
      headless: true,
      timeoutSeconds: 900,
    };
    await triggerCrawlHandler(input, defaultContext);
    const [, contextData] = mockExecute.mock.calls[0];
    expect((contextData as any).projectId).toBe(input.projectUuid);
    expect((contextData as any).headless).toBe(true);
    expect((contextData as any).timeoutSeconds).toBe(900);
  });

  test('template not found: throws a clear error', async () => {
    setupHappyPath({ isLocalhost: false });
    mockFindTemplateByName.mockResolvedValue(null);
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
});
