/**
 * check_app_in_browser — credential forwarding and identity surfacing.
 *
 * The bug: a run that named its own account still signed in as the
 * environment's default test user, and the app's correct rejection of the wrong
 * account came back as an application failure. These pin the MCP's half of the
 * fix — the caller's credentials reach the backend as an authoritative signal,
 * and the identity actually used comes back in the result so a substitution is
 * visible instead of masquerading as a broken app.
 */
import { jest } from '@jest/globals';
import type { ToolContext } from '../../types/index.js';

const mockProvision = jest.fn<() => Promise<any>>();
const mockFindTemplate = jest.fn<() => Promise<any>>();
const mockExecute = jest.fn<() => Promise<any>>();
const mockPoll = jest.fn<() => Promise<any>>();
const mockRevokeKey = jest.fn<() => Promise<void>>();
const mockInit = jest.fn<() => Promise<void>>();
const mockFindProject = jest.fn<(repo: string) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    tunnels: { provision: mockProvision, provisionWithRetry: mockProvision },
    workflows: {
      findEvaluationTemplate: mockFindTemplate,
      executeWorkflow: mockExecute,
      pollExecution: mockPoll,
    },
    revokeNgrokKey: mockRevokeKey,
    findProjectByRepoName: mockFindProject,
  })),
}));

jest.unstable_mockModule('../../utils/tunnelContext.js', () => ({
  resolveTargetUrl: jest.fn(() => 'https://app.example.com'),
  buildContext: jest.fn(() => ({ originalUrl: 'https://app.example.com', isLocalhost: false })),
  findExistingTunnel: jest.fn(() => null),
  ensureTunnel: jest.fn(),
  sanitizeResponseUrls: jest.fn((v: any) => v),
  touchTunnelById: jest.fn(),
}));

jest.unstable_mockModule('../../utils/imageUtils.js', () => ({
  fetchImageAsBase64: jest.fn().mockResolvedValue(null),
  imageContentBlock: jest.fn(),
  resourceLinkBlock: jest.fn(),
  artifactResourceLinks: jest.fn(() => []),
}));

jest.unstable_mockModule('../../utils/localReachability.js', () => ({
  probeLocalPort: jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue({ reachable: true, elapsedMs: 1 }),
  probeTunnelHealth: jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue({ healthy: true, elapsedMs: 1 }),
  extractNgrokErrorCode: (body: string) => body.match(/ERR_NGROK_\d+/)?.[0],
}));

jest.unstable_mockModule('../../services/ngrok/tunnelManager.js', () => ({
  tunnelManager: {
    stopTunnel: jest.fn<() => Promise<void>>().mockResolvedValue(),
    markTunnelDead: jest.fn<(...a: any[]) => Promise<void>>().mockResolvedValue(),
  },
}));

let testPageChangesHandler: typeof import('../../handlers/testPageChangesHandler.js').testPageChangesHandler;
let TestPageChangesInputSchema: typeof import('../../types/index.js').TestPageChangesInputSchema;

beforeAll(async () => {
  testPageChangesHandler = (await import('../../handlers/testPageChangesHandler.js')).testPageChangesHandler;
  TestPageChangesInputSchema = (await import('../../types/index.js')).TestPageChangesInputSchema;
});

const ctx: ToolContext = { requestId: 'cred-test', timestamp: new Date() };
const TEMPLATE = { uuid: 'tmpl-1', name: 'App Evaluation', description: '', isTemplate: true, isActive: true };

function completedExecution(evidence?: Record<string, any>) {
  return {
    uuid: 'exec-1',
    status: 'completed',
    startedAt: '2026-07-26T10:00:00Z',
    completedAt: '2026-07-26T10:02:00Z',
    durationMs: 120000,
    state: { outcome: 'fail', success: false, stepsTaken: 4, error: '' },
    verdict: { outcome: 'fail', reason: 'No active account found with the given credentials' },
    budget: { maxSteps: 25, usedSteps: 4 },
    evidence: { screenshot: null, actionTrace: [], ...(evidence ?? {}) },
    errorMessage: '',
    errorInfo: null,
    nodeExecutions: [],
  };
}

function setup(execution: any = completedExecution()) {
  jest.clearAllMocks();
  mockInit.mockResolvedValue(undefined);
  mockFindTemplate.mockResolvedValue(TEMPLATE);
  mockFindProject.mockResolvedValue({ uuid: 'proj-1', name: 'Test Project' });
  mockExecute.mockResolvedValue({
    executionUuid: 'exec-1',
    resolvedEnvironmentId: 'env-1',
    resolvedCredentialId: 'cred-1',
  });
  mockPoll.mockResolvedValue(execution);
}

function sentEnv(): Record<string, any> {
  return mockExecute.mock.calls[0][2] as Record<string, any>;
}

function payload(result: any): Record<string, any> {
  return JSON.parse(result.content[0].text!);
}

const baseInput = {
  description: 'set a password then sign in',
  url: 'https://app.example.com',
  repoName: 'acme/app',
};

// ── forwarding ──────────────────────────────────────────────────────────────

describe('mid-flow credentials reach the backend', () => {
  test('loginCredentials are forwarded as env.taskCredentials', async () => {
    setup();
    await testPageChangesHandler(
      {
        ...baseInput,
        loginCredentials: [
          { username: 'qa+invitefix@example.com', password: 'Fix-Test-Pw-2026!', label: 'invited user' },
        ],
      } as any,
      ctx,
    );

    expect(sentEnv().taskCredentials).toEqual([
      { username: 'qa+invitefix@example.com', password: 'Fix-Test-Pw-2026!', label: 'invited user' },
    ]);
  });

  test('the optional label is omitted rather than sent as undefined', async () => {
    setup();
    await testPageChangesHandler(
      { ...baseInput, loginCredentials: [{ username: 'a@b.c', password: 'pw' }] } as any,
      ctx,
    );
    expect(sentEnv().taskCredentials[0]).toEqual({ username: 'a@b.c', password: 'pw' });
    expect(sentEnv().taskCredentials[0]).not.toHaveProperty('label');
  });

  test('auth.username/password pin the precondition login identity', async () => {
    setup();
    await testPageChangesHandler(
      {
        ...baseInput,
        auth: {
          precondition: 'login',
          username: 'specific@example.com',
          password: 'pw',
          deepUrl: 'https://app.example.com/settings',
        },
      } as any,
      ctx,
    );

    const contextData = mockExecute.mock.calls[0][1] as Record<string, any>;
    expect(contextData.auth).toEqual({
      precondition: 'login',
      username: 'specific@example.com',
      password: 'pw',
      deepUrl: 'https://app.example.com/settings',
    });
  });

  test('useEnvironmentCredentials:false is forwarded as an explicit opt-out', async () => {
    setup();
    await testPageChangesHandler(
      { ...baseInput, username: 'a@b.c', password: 'pw', useEnvironmentCredentials: false } as any,
      ctx,
    );
    expect(sentEnv().useEnvironmentCredentials).toBe(false);
  });

  test('the opt-out is omitted when not requested, so the backend default stands', async () => {
    setup();
    await testPageChangesHandler({ ...baseInput, username: 'a@b.c', password: 'pw' } as any, ctx);
    expect(sentEnv()).not.toHaveProperty('useEnvironmentCredentials');
  });

  test('no credentials at all still sends no env block', async () => {
    setup();
    await testPageChangesHandler(baseInput as any, ctx);
    expect(mockExecute.mock.calls[0][2]).toBeUndefined();
  });
});

// ── validation ──────────────────────────────────────────────────────────────

describe('input validation', () => {
  test('a login credential without a password is rejected', () => {
    const parsed = TestPageChangesInputSchema.safeParse({
      ...baseInput,
      loginCredentials: [{ username: 'a@b.c' }],
    });
    expect(parsed.success).toBe(false);
  });

  test('opting out of env credentials without naming an account is rejected', () => {
    const parsed = TestPageChangesInputSchema.safeParse({
      ...baseInput,
      useEnvironmentCredentials: false,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toMatch(/no way to authenticate/);
    }
  });

  test('opting out is accepted when an account is named', () => {
    for (const named of [
      { username: 'a@b.c', password: 'pw' },
      { credentialId: '11111111-1111-1111-1111-111111111111' },
      { credentialRole: 'admin' },
      { loginCredentials: [{ username: 'a@b.c', password: 'pw' }] },
      { auth: { username: 'a@b.c', password: 'pw' } },
    ]) {
      const parsed = TestPageChangesInputSchema.safeParse({
        ...baseInput,
        useEnvironmentCredentials: false,
        ...named,
      });
      expect(parsed.success).toBe(true);
    }
  });
});

// ── surfacing ───────────────────────────────────────────────────────────────

describe('the identity actually used is visible in the result', () => {
  test('evidence.logins is relayed', async () => {
    setup(completedExecution({
      logins: [
        { username: 'qa+invitefix@example.com', source: 'task', submitted: true, authenticated: true },
      ],
    }));

    const result = await testPageChangesHandler(
      { ...baseInput, loginCredentials: [{ username: 'qa+invitefix@example.com', password: 'pw' }] } as any,
      ctx,
    );

    expect(payload(result).logins).toEqual([
      { username: 'qa+invitefix@example.com', source: 'task', submitted: true, authenticated: true },
    ]);
  });

  test('a substitution is called out instead of reading as an app failure', async () => {
    setup(completedExecution({
      logins: [
        { username: 'qatest123@example.com', source: 'env_default', submitted: true, authenticated: false },
      ],
    }));

    const result = await testPageChangesHandler(
      { ...baseInput, username: 'qa+invitefix@example.com', password: 'pw' } as any,
      ctx,
    );

    const body = payload(result);
    expect(body.credentialWarning).toBeDefined();
    expect(body.credentialWarning.requested).toBe('qa+invitefix@example.com');
    expect(body.credentialWarning.used).toEqual(['qatest123@example.com']);
    expect(body.credentialWarning.message).toMatch(/credential-resolution problem, not an application failure/);
  });

  test('no warning when the run used the account that was asked for', async () => {
    setup(completedExecution({
      logins: [
        { username: 'qa+invitefix@example.com', source: 'explicit', submitted: true, authenticated: true },
      ],
    }));

    const result = await testPageChangesHandler(
      { ...baseInput, username: 'qa+invitefix@example.com', password: 'pw' } as any,
      ctx,
    );
    expect(payload(result)).not.toHaveProperty('credentialWarning');
  });

  test('no warning when the caller named nobody — an env default is correct there', async () => {
    setup(completedExecution({
      logins: [
        { username: 'qatest123@example.com', source: 'env_default', submitted: true, authenticated: true },
      ],
    }));

    const result = await testPageChangesHandler(baseInput as any, ctx);
    expect(payload(result)).not.toHaveProperty('credentialWarning');
    expect(payload(result).logins).toHaveLength(1);
  });

  test('a declined identity is surfaced as loginError', async () => {
    setup(completedExecution({
      logins: [],
      loginError: {
        reason: 'requested_identity_unavailable',
        detail: "no stored credential for 'ghost@example.com'",
      },
    }));

    const result = await testPageChangesHandler(
      { ...baseInput, username: 'ghost@example.com' } as any,
      ctx,
    );
    expect(payload(result).loginError).toEqual({
      reason: 'requested_identity_unavailable',
      detail: "no stored credential for 'ghost@example.com'",
    });
  });

  test('a pre-contract backend (no evidence.logins) omits the fields entirely', async () => {
    setup(completedExecution());
    const result = await testPageChangesHandler(
      { ...baseInput, username: 'a@b.c', password: 'pw' } as any,
      ctx,
    );
    const body = payload(result);
    expect(body).not.toHaveProperty('logins');
    expect(body).not.toHaveProperty('loginError');
    expect(body).not.toHaveProperty('credentialWarning');
  });
});
