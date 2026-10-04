/**
 * The MCP is a relay, not an author.
 *
 * Every tool response is the backend's data, under the backend's field names,
 * with the backend's reasons verbatim. The MCP may author text ONLY for facts it
 * observed itself (its poll deadline, a tunnel/connection failure, the tunnel
 * rewrite it applied, input validation) — never headlines, advice, hints,
 * restated verdicts, explanatory prose around fields, or duplicate copies of a
 * value the payload already carries.
 *
 * The core check is PROVENANCE, not a phrase blocklist: every string leaf in a
 * success response must have come from the mocked backend (or the caller's own
 * input). A blocklist only catches the sentences somebody already found; this
 * catches the next one too.
 */

import { jest } from '@jest/globals';
import type { ToolContext } from '../../types/index.js';

// ── backend client mock (one client serves every handler in this file) ─────

const m = {
  init: jest.fn<() => Promise<void>>(),
  findTemplate: jest.fn<() => Promise<any>>(),
  findTemplateBySlug: jest.fn<(slug: string) => Promise<any>>(),
  execute: jest.fn<(...a: any[]) => Promise<any>>(),
  poll: jest.fn<(...a: any[]) => Promise<any>>(),
  getExecution: jest.fn<(uuid: string) => Promise<any>>(),
  listExecutions: jest.fn<(f: any) => Promise<any>>(),
  findProject: jest.fn<(repo: string) => Promise<any>>(),
  getProject: jest.fn<(uuid: string) => Promise<any>>(),
  listProjects: jest.fn<(...a: any[]) => Promise<any>>(),
  getEnvironment: jest.fn<(...a: any[]) => Promise<any>>(),
  listEnvironmentsPaginated: jest.fn<(...a: any[]) => Promise<any>>(),
  listCredentialsForEnvironment: jest.fn<(...a: any[]) => Promise<any>>(),
  createEnvironment: jest.fn<(...a: any[]) => Promise<any>>(),
  updateEnvironment: jest.fn<(...a: any[]) => Promise<any>>(),
  listEnvironmentSessions: jest.fn<(...a: any[]) => Promise<any>>(),
  clearEnvironmentSessions: jest.fn<(...a: any[]) => Promise<any>>(),
  runTestSuite: jest.fn<(...a: any[]) => Promise<any>>(),
};

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: m.init,
    tunnels: { provisionWithRetry: jest.fn(), revoke: jest.fn() },
    workflows: {
      findEvaluationTemplate: m.findTemplate,
      findTemplateBySlug: m.findTemplateBySlug,
      executeWorkflow: m.execute,
      pollExecution: m.poll,
      getExecution: m.getExecution,
      listExecutions: m.listExecutions,
      cancelExecution: jest.fn(),
    },
    findProjectByRepoName: m.findProject,
    getProject: m.getProject,
    listProjects: m.listProjects,
    getEnvironment: m.getEnvironment,
    listEnvironmentsPaginated: m.listEnvironmentsPaginated,
    listCredentialsForEnvironment: m.listCredentialsForEnvironment,
    createEnvironment: m.createEnvironment,
    updateEnvironment: m.updateEnvironment,
    listEnvironmentSessions: m.listEnvironmentSessions,
    clearEnvironmentSessions: m.clearEnvironmentSessions,
    runTestSuite: m.runTestSuite,
  })),
}));

let localhostMode = false;
jest.unstable_mockModule('../../utils/tunnelContext.js', () => ({
  resolveTargetUrl: jest.fn((input: any) => input.url),
  buildContext: jest.fn((url: string) => ({
    originalUrl: url,
    isLocalhost: localhostMode,
  })),
  findExistingTunnel: jest.fn(() => null),
  ensureTunnel: jest.fn(),
  acquirePortRoute: jest.fn(async (ctx: any) => ctx),
  releasePortRoute: jest.fn(),
  sanitizeResponseUrls: jest.fn((v: any) => v),
  touchTunnelById: jest.fn(),
  retargetAuxiliaryUrl: jest.fn((_c: any, url: string) => ({ ok: true, url, rewritten: false })),
}));

jest.unstable_mockModule('../../utils/imageUtils.js', () => ({
  fetchImageAsBase64: jest.fn<() => Promise<any>>().mockResolvedValue(null),
  imageContentBlock: jest.fn((data: string, mimeType: string) => ({ type: 'image', data, mimeType })),
  resourceLinkBlock: jest.fn(),
  artifactResourceLinks: jest.fn(() => []),
}));

const probeLocalPort = jest.fn<(port: number) => Promise<any>>();
jest.unstable_mockModule('../../utils/localReachability.js', () => ({
  probeLocalPort,
  probeTunnelHealth: jest.fn<() => Promise<any>>().mockResolvedValue({ healthy: true, elapsedMs: 1 }),
  extractTunnelErrorCode: (body: string) => body.match(/DEBUGG_TUNNEL_[A-Z_]+/)?.[0],
}));

jest.unstable_mockModule('../../services/tunnel/tunnelManager.js', () => ({
  tunnelManager: { stopTunnel: jest.fn(), markTunnelDead: jest.fn(), acquireDedicatedTunnel: jest.fn() },
}));

jest.unstable_mockModule('../../utils/gitContext.js', () => ({
  detectRepoName: jest.fn(() => 'acme/app'),
  detectLocalGitRef: jest.fn(async () => ({})),
}));

let testPageChangesHandler: typeof import('../../handlers/testPageChangesHandler.js').testPageChangesHandler;
let triggerCrawlHandler: typeof import('../../handlers/triggerCrawlHandler.js').triggerCrawlHandler;
let probePageHandler: typeof import('../../handlers/probePageHandler.js').probePageHandler;
let projectHandler: typeof import('../../handlers/projectHandler.js').projectHandler;
let executionsHandler: typeof import('../../handlers/executionsHandler.js').executionsHandler;
let environmentHandler: typeof import('../../handlers/environmentHandler.js').environmentHandler;
let runTestSuiteHandler: typeof import('../../handlers/runTestSuiteHandler.js').runTestSuiteHandler;
let ensureConfirmed: typeof import('../../utils/confirmDestructive.js').ensureConfirmed;
let checkAuthorizedCredentialHostsEcho: typeof import('../../utils/authorizedCredentialHosts.js').checkAuthorizedCredentialHostsEcho;

beforeAll(async () => {
  testPageChangesHandler = (await import('../../handlers/testPageChangesHandler.js')).testPageChangesHandler;
  triggerCrawlHandler = (await import('../../handlers/triggerCrawlHandler.js')).triggerCrawlHandler;
  probePageHandler = (await import('../../handlers/probePageHandler.js')).probePageHandler;
  projectHandler = (await import('../../handlers/projectHandler.js')).projectHandler;
  executionsHandler = (await import('../../handlers/executionsHandler.js')).executionsHandler;
  environmentHandler = (await import('../../handlers/environmentHandler.js')).environmentHandler;
  runTestSuiteHandler = (await import('../../handlers/runTestSuiteHandler.js')).runTestSuiteHandler;
  ensureConfirmed = (await import('../../utils/confirmDestructive.js')).ensureConfirmed;
  checkAuthorizedCredentialHostsEcho = (await import('../../utils/authorizedCredentialHosts.js')).checkAuthorizedCredentialHostsEcho;
});

const ctx: ToolContext = { requestId: 'relay', timestamp: new Date() };

beforeEach(() => {
  jest.clearAllMocks();
  localhostMode = false;
  m.init.mockResolvedValue(undefined);
  m.findTemplate.mockResolvedValue({ uuid: 'tmpl-1', name: 'App Evaluation' });
  m.findTemplateBySlug.mockResolvedValue({ uuid: 'tmpl-2', name: 'Raw Crawl' });
  m.findProject.mockResolvedValue({ uuid: 'proj-1', name: 'p' });
  m.execute.mockResolvedValue({ executionUuid: 'exec-1' });
  probeLocalPort.mockResolvedValue({ reachable: true, elapsedMs: 1 });
});

// ── provenance helpers ──────────────────────────────────────────────────────

function stringLeaves(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => stringLeaves(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringLeaves(x, out));
  return out;
}

/** Every string the response carries must have been handed to us. */
function expectOnlyRelayedStrings(response: unknown, ...sources: unknown[]) {
  const allowed = new Set<string>();
  sources.forEach((s) => stringLeaves(s, allowed));
  const authored = [...stringLeaves(response)].filter((s) => !allowed.has(s));
  expect(authored).toEqual([]);
}

function body(result: any): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

// Phrases that only ever appear when the MCP is advising, hedging or blaming.
const ADVICE = /\b(should|make sure|ensure|try again|retry it|retry|verify your|common causes|likely|probably|may still|start your|link this repo|pass [a-z]+ explicitly|use action|treat a|not your|our side|tip:)\b/i;

// ── check_app_in_browser ────────────────────────────────────────────────────

const PASS_EXEC = {
  uuid: 'exec-1',
  status: 'completed',
  durationMs: 4242,
  state: { outcome: 'pass', stepsTaken: 3, error: '' },
  verdict: { outcome: 'pass', reason: 'SENTINEL backend reason: heading "Welcome" visible at /home' },
  budget: { maxSteps: 20, usedSteps: 3 },
  evidence: {
    screenshot: null,
    actionTrace: [{ step: 1, action: 'navigate', intent: 'SENTINEL intent open /home' }],
    logins: [{ username: 'sentinel@example.com', source: 'explicit', submitted: true, authenticated: true }],
    report: 'SENTINEL report text',
  },
  evaluation: {
    passed: true,
    outcome: 'pass',
    reason: 'SENTINEL backend reason: heading "Welcome" visible at /home',
    verifications: [{ check: 'text_visible', value: 'SENTINEL Welcome' }],
  },
  errorMessage: '',
  errorInfo: null,
  nodeExecutions: [],
};

const CHECK_INPUT = { description: 'SENTINEL goal', url: 'https://app.example.com', repoName: 'acme/app' };

describe('check_app_in_browser relays, never authors', () => {
  test('every string in a pass response came from the backend or the caller', async () => {
    m.poll.mockResolvedValue(PASS_EXEC);
    const r = await testPageChangesHandler(CHECK_INPUT as any, ctx);
    const b = body(r);
    expectOnlyRelayedStrings(b, PASS_EXEC, CHECK_INPUT);
  });

  test('no derived duplicates of the verdict or the budget', async () => {
    m.poll.mockResolvedValue(PASS_EXEC);
    const b = body(await testPageChangesHandler(CHECK_INPUT as any, ctx));
    // success === (outcome === 'pass'); failureCategory === outcome;
    // stepsRemaining === maxSteps - usedSteps. Each restates a field already there.
    for (const k of ['success', 'failureCategory', 'stepsRemaining', 'stepsTaken', 'stepsBudget']) {
      expect(b).not.toHaveProperty(k);
    }
    // the backend's own container, under the backend's own field names
    expect(b.budget).toEqual({ maxSteps: 20, usedSteps: 3 });
    expect(b.outcome).toBe('pass');
    expect(b.reason).toBe(PASS_EXEC.verdict.reason);
  });

  test('evaluation does not repeat the verdict it was derived from', async () => {
    m.poll.mockResolvedValue(PASS_EXEC);
    const b = body(await testPageChangesHandler(CHECK_INPUT as any, ctx));
    // passed/outcome/reason are the verdict a second time; only what the verdict lacks remains
    expect(b.evaluation).toEqual({ verifications: PASS_EXEC.evaluation.verifications });
  });

  test('evaluation is omitted when it carries nothing the verdict does not', async () => {
    const { verifications: _v, ...dupOnly } = PASS_EXEC.evaluation;
    m.poll.mockResolvedValue({ ...PASS_EXEC, evaluation: dupOnly });
    const b = body(await testPageChangesHandler(CHECK_INPUT as any, ctx));
    expect(b).not.toHaveProperty('evaluation');
  });

  test('errorInfo is relayed as the backend sent it, not renamed', async () => {
    const errorInfo = { failedNodeId: 'node-7', nodeType: 'browser.setup' };
    m.poll.mockResolvedValue({ ...PASS_EXEC, errorInfo });
    const b = body(await testPageChangesHandler(CHECK_INPUT as any, ctx));
    expect(b.errorInfo).toEqual(errorInfo);
    expect(b).not.toHaveProperty('failedNode');
  });

  test('a credential substitution is reported as facts, with no advice attached', async () => {
    m.poll.mockResolvedValue({
      ...PASS_EXEC,
      evidence: {
        ...PASS_EXEC.evidence,
        logins: [{ username: 'default@example.com', source: 'env_default', submitted: true, authenticated: false }],
      },
    });
    const b = body(await testPageChangesHandler({ ...CHECK_INPUT, username: 'named@example.com', password: 'x' } as any, ctx));
    expect(b.credentialWarning).toEqual({ requested: 'named@example.com', used: ['default@example.com'] });
  });

  test('progress never shows a retired outcome to the user', async () => {
    const progress = jest.fn<(u: any) => Promise<void>>().mockResolvedValue(undefined);
    m.poll.mockImplementation(async (_uuid: string, onUpdate: any) => {
      const exec = { ...PASS_EXEC, state: { ...PASS_EXEC.state, outcome: 'inconclusive' } };
      await onUpdate(exec);
      return exec;
    });
    await testPageChangesHandler(CHECK_INPUT as any, ctx, progress);
    const messages = progress.mock.calls.map((c) => c[0].message as string);
    expect(messages.join('\n')).not.toMatch(/inconclusive|unverified|unknown|abandoned/);
  });

  test('ProjectRequired states what happened, without instructions', async () => {
    m.findProject.mockResolvedValue(null);
    m.poll.mockResolvedValue(PASS_EXEC);
    // a repo no earlier test resolved, so the project cache cannot answer for it
    const r = await testPageChangesHandler({ ...CHECK_INPUT, repoName: 'acme/unlinked' } as any, ctx);
    expect(r.isError).toBe(true);
    const b = body(r);
    expect(b.error).toBe('ProjectRequired');
    expect(b.message).not.toMatch(ADVICE);
    expect(b.message).not.toMatch(/https:\/\/debugg\.ai|then retry|pass repoName/i);
  });

  test('LocalServerUnreachable is the observed probe result, not a to-do list', async () => {
    localhostMode = true;
    probeLocalPort.mockResolvedValue({ reachable: false, code: 'ECONNREFUSED', detail: 'connect ECONNREFUSED 127.0.0.1:3999', elapsedMs: 3 });
    const r = await testPageChangesHandler({ ...CHECK_INPUT, url: 'http://localhost:3999' } as any, ctx);
    expect(r.isError).toBe(true);
    const b = body(r);
    expect(b.error).toBe('LocalServerUnreachable');
    expect(b.message).toContain('127.0.0.1:3999');
    expect(b.message).not.toMatch(ADVICE);
    expect(b.detail).toMatchObject({ port: 3999, probeCode: 'ECONNREFUSED' });
  });
});

// ── trigger_crawl ───────────────────────────────────────────────────────────

describe('trigger_crawl relays node output, never fills in defaults', () => {
  test('knowledgeGraph carries only keys the backend reported', async () => {
    m.poll.mockResolvedValue({
      uuid: 'exec-1',
      status: 'completed',
      durationMs: 10,
      state: { outcome: 'pass' },
      errorMessage: '',
      errorInfo: null,
      nodeExecutions: [
        { nodeId: 'k', nodeType: 'knowledge_graph.import', status: 'success', executionOrder: 1, outputData: { skipped: true } },
        { nodeId: 'c', nodeType: 'surfer.crawl', status: 'success', executionOrder: 0, outputData: { pagesDiscovered: 4 } },
      ],
    });
    const b = body(await triggerCrawlHandler({ url: 'https://app.example.com' } as any, ctx));
    // no invented reason:'', edgesImported:0, knowledgeGraphId:'' or derived `imported`
    expect(b.knowledgeGraph).toEqual({ skipped: true });
    expect(b.crawlSummary).toEqual({ pagesDiscovered: 4 });
  });

  test('LocalServerUnreachable carries no instructions', async () => {
    localhostMode = true;
    probeLocalPort.mockResolvedValue({ reachable: false, code: 'ECONNREFUSED', elapsedMs: 3 });
    const r = await triggerCrawlHandler({ url: 'http://localhost:3999' } as any, ctx);
    expect(body(r).message).not.toMatch(ADVICE);
  });
});

// ── probe_page ──────────────────────────────────────────────────────────────

describe('probe_page', () => {
  test('LocalServerUnreachable carries no instructions', async () => {
    localhostMode = true;
    probeLocalPort.mockResolvedValue({ reachable: false, code: 'ECONNREFUSED', elapsedMs: 3 });
    const r = await probePageHandler({ targets: [{ url: 'http://localhost:3999' }], includeHtml: false, captureScreenshots: false } as any, ctx);
    expect(r.isError).toBe(true);
    expect(body(r).message).not.toMatch(ADVICE);
  });

  test('a metric the backend did not report is null, not a fabricated 0 or the input URL', async () => {
    m.poll.mockResolvedValue({
      uuid: 'exec-1', status: 'completed', durationMs: 5, state: {}, errorMessage: '', errorInfo: null,
      nodeExecutions: [
        { nodeId: 'cap', nodeType: 'browser.capture', status: 'success', executionOrder: 1, outputData: { title: 'T' } },
      ],
    });
    const b = body(await probePageHandler({ targets: [{ url: 'https://app.example.com/x' }], includeHtml: false, captureScreenshots: false } as any, ctx));
    expect(b.results[0].statusCode).toBeNull();
    expect(b.results[0].loadTimeMs).toBeNull();
    expect(b.results[0].finalUrl).toBeNull();
  });
});

// ── project / executions / environment ─────────────────────────────────────

describe('lookup tools return the backend object, not an MCP envelope', () => {
  test('project get returns the project — no echoed filter, no fabricated pageInfo', async () => {
    const project = { uuid: 'proj-1', name: 'SENTINEL project', slug: 's' };
    m.getProject.mockResolvedValue(project);
    const b = body(await projectHandler({ action: 'get', uuid: 'proj-1' } as any, ctx));
    expect(b).toEqual({ project });
  });

  test('project list does not echo the caller\'s filter back', async () => {
    m.listProjects.mockResolvedValue({ pageInfo: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false }, projects: [] });
    const b = body(await projectHandler({ action: 'list', q: 'abc' } as any, ctx));
    expect(b).not.toHaveProperty('filter');
  });

  test('executions get returns the execution — no echoed filter, no fabricated pageInfo', async () => {
    const execution = { uuid: 'exec-1', status: 'completed', outcome: 'pass', nodeExecutions: [] };
    m.getExecution.mockResolvedValue(execution);
    const b = body(await executionsHandler({ action: 'get', uuid: 'exec-1' } as any, ctx));
    expect(b).toEqual({ execution });
  });

  test('executions never show a retired outcome; a running row keeps its null', async () => {
    m.listExecutions.mockResolvedValue({
      pageInfo: { page: 1, pageSize: 20, totalCount: 3, totalPages: 1, hasMore: false },
      executions: [
        { uuid: 'a', status: 'completed', outcome: 'unverified' },
        { uuid: 'b', status: 'completed', outcome: 'fail' },
        { uuid: 'c', status: 'running', outcome: null },
      ],
    });
    const b = body(await executionsHandler({ action: 'list' } as any, ctx));
    expect(b).not.toHaveProperty('filter');
    expect(b.executions.map((e: any) => e.outcome)).toEqual(['error', 'fail', null]);
  });

  test('executions get maps every user-visible verdict field through the same allowlist', async () => {
    m.getExecution.mockResolvedValue({
      uuid: 'exec-1', status: 'completed', outcome: 'unverified',
      verdict: { outcome: 'inconclusive', reason: 'r' },
      evaluation: { passed: null, outcome: 'inconclusive', reason: 'r' },
      state: { outcome: 'unverified' },
      nodeExecutions: [],
    });
    const { execution } = body(await executionsHandler({ action: 'get', uuid: 'exec-1' } as any, ctx));
    expect(execution.outcome).toBe('error');
    expect(execution.verdict.outcome).toBe('error');
    expect(execution.evaluation.outcome).toBe('error');
    // internal run state is raw backend data, left as-is
    expect(execution.state.outcome).toBe('unverified');
  });

  test('environment get returns the environment — no echoed filter, no fabricated pageInfo', async () => {
    m.getEnvironment.mockResolvedValue({ uuid: 'env-1', name: 'SENTINEL env' });
    m.listCredentialsForEnvironment.mockResolvedValue([]);
    const b = body(await environmentHandler({ action: 'get', uuid: 'env-1', projectUuid: 'proj-1' } as any, ctx));
    expect(b).not.toHaveProperty('filter');
    expect(b).not.toHaveProperty('pageInfo');
    expect(b.environment).toEqual({ uuid: 'env-1', name: 'SENTINEL env', credentials: [] });
  });

  test('environment sessions is the backend list — no note, no derived counts', async () => {
    const sessions = [{ username: 'a@example.com', isUsable: true }];
    m.listEnvironmentSessions.mockResolvedValue(sessions);
    const r = await environmentHandler({ action: 'sessions', uuid: 'env-1' } as any, ctx);
    expect(body(r)).toEqual({ environmentUuid: 'env-1', sessions });
  });

  test('environment clearSessions is the backend count — no note, no invented scope', async () => {
    m.clearEnvironmentSessions.mockResolvedValue({ invalidated: 2 });
    const r = await environmentHandler({ action: 'clearSessions', uuid: 'env-1', username: 'a@example.com' } as any, ctx);
    expect(body(r)).toEqual({ environmentUuid: 'env-1', invalidated: 2 });
  });
});

// ── test_suite run / confirmations / warnings ──────────────────────────────

describe('no instructions appended to results', () => {
  test('test_suite run returns the backend result with no note', async () => {
    m.runTestSuite.mockResolvedValue({ suiteUuid: 'suite-1', runStatus: 'running' });
    const b = body(await runTestSuiteHandler({ suiteUuid: 'suite-1' } as any, ctx));
    expect(b).toEqual({ suiteUuid: 'suite-1', runStatus: 'running' });
  });

  test('a refused destructive action states the rule, not client advice', async () => {
    const r = await ensureConfirmed('delete', 'environment env-1', {}, ctx);
    const b = body(r);
    expect(b.message).not.toMatch(/elicitation-capable client/i);
  });

  test('authorizedCredentialHostsWarning is the requested/returned comparison, no prose', () => {
    const w = checkAuthorizedCredentialHostsEcho(['auth.example.com'], undefined);
    expect(w).toEqual({ requested: ['auth.example.com'], returned: null });
  });
});
