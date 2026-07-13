import { jest } from '@jest/globals';

// Mock gitContext before importing projectContext
jest.unstable_mockModule('../../utils/gitContext.js', () => ({
  detectRepoName: jest.fn<() => string | null>(),
}));

// Mock DebuggAIServerClient
jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: jest.fn(),
    tx: {
      get: jest.fn(),
    },
    findProjectByRepoName: jest.fn(),
  })),
}));

// Mock config
jest.unstable_mockModule('../../config/index.js', () => ({
  config: {
    api: { key: 'test-key', baseUrl: 'https://api.test.com', tokenType: 'token' },
    logging: { level: 'error', format: 'simple' },
    server: { name: 'test', version: '0.0.0' },
    defaults: {},
    telemetry: {},
  },
}));

describe('resolveProjectContext', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns null when no git repo detected', async () => {
    const { detectRepoName } = await import('../../utils/gitContext.js');
    (detectRepoName as jest.Mock).mockReturnValue(null);

    const { resolveProjectContext } = await import('../../services/projectContext.js');
    const result = await resolveProjectContext();
    expect(result).toBeNull();
  });

  it('returns null when project not found on backend', async () => {
    const { detectRepoName } = await import('../../utils/gitContext.js');
    (detectRepoName as jest.Mock).mockReturnValue('org/repo');

    const { DebuggAIServerClient } = await import('../../services/index.js');
    const mockClient = new (DebuggAIServerClient as any)();
    mockClient.findProjectByRepoName.mockResolvedValue(null);
    (DebuggAIServerClient as jest.Mock).mockImplementation(() => mockClient);

    const { resolveProjectContext } = await import('../../services/projectContext.js');
    const result = await resolveProjectContext();
    expect(result).toBeNull();
  });

  it('resolves project + environments with inline credential labels (pinned contract)', async () => {
    const { detectRepoName } = await import('../../utils/gitContext.js');
    (detectRepoName as jest.Mock).mockReturnValue('org/repo');

    const mockProject = { uuid: 'proj-1', name: 'My Project', slug: 'my-project' };
    // Pinned contract: GET /api/v1/environments/?project=<uuid> returns
    // environments with credentials inlined; password is never present.
    // (Axios transport auto-converts snake_case → camelCase.)
    const mockEnvs = {
      results: [
        {
          uuid: 'env-1',
          name: 'Production',
          url: 'https://app.test.com',
          isDefault: true,
          isActive: true,
          endpointType: 'frontend',
          credentials: [
            { label: 'Admin', username: 'admin@test.com' },
          ],
        },
        { uuid: 'env-2', name: 'Inactive', url: '', isActive: false, credentials: [] },
      ],
    };

    const { DebuggAIServerClient } = await import('../../services/index.js');
    const mockClient = new (DebuggAIServerClient as any)();
    mockClient.findProjectByRepoName.mockResolvedValue(mockProject);
    const getCalls: Array<{ url: string; params: any }> = [];
    mockClient.tx.get.mockImplementation(async (url: string, params: any) => {
      getCalls.push({ url, params });
      if (url.includes('/environments/')) return mockEnvs;
      return { results: [] };
    });
    (DebuggAIServerClient as jest.Mock).mockImplementation(() => mockClient);

    const { resolveProjectContext } = await import('../../services/projectContext.js');
    const result = await resolveProjectContext();

    expect(result).not.toBeNull();
    expect(result!.project.uuid).toBe('proj-1');
    // Consumes the single project-scoped environments endpoint (no per-env
    // credentials round-trip).
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].url).toBe('api/v1/environments/');
    expect(getCalls[0].params).toEqual({ project: 'proj-1' });
    // Only active environments
    expect(result!.environments).toHaveLength(1);
    expect(result!.environments[0].name).toBe('Production');
    expect(result!.environments[0].isDefault).toBe(true);
    expect(result!.environments[0].endpointType).toBe('frontend');
    expect(result!.environments[0].credentials).toHaveLength(1);
    expect(result!.environments[0].credentials[0].label).toBe('Admin');
    expect(result!.environments[0].credentials[0].username).toBe('admin@test.com');
    // Labels only — no secret leaks into the resolved context.
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('handles a bare-array environments response (no DRF pagination wrapper)', async () => {
    const { detectRepoName } = await import('../../utils/gitContext.js');
    (detectRepoName as jest.Mock).mockReturnValue('org/repo');

    const { DebuggAIServerClient } = await import('../../services/index.js');
    const mockClient = new (DebuggAIServerClient as any)();
    mockClient.findProjectByRepoName.mockResolvedValue({ uuid: 'proj-2', name: 'P2', slug: 'p2' });
    mockClient.tx.get.mockResolvedValue([
      { uuid: 'env-9', name: 'Staging', url: 'https://staging.test.com', isActive: true, credentials: [] },
    ]);
    (DebuggAIServerClient as jest.Mock).mockImplementation(() => mockClient);

    const { resolveProjectContext } = await import('../../services/projectContext.js');
    const result = await resolveProjectContext();

    expect(result).not.toBeNull();
    expect(result!.environments).toHaveLength(1);
    expect(result!.environments[0].name).toBe('Staging');
  });

  it('times out after 10s and returns null', async () => {
    const { detectRepoName } = await import('../../utils/gitContext.js');
    (detectRepoName as jest.Mock).mockReturnValue('org/repo');

    const { DebuggAIServerClient } = await import('../../services/index.js');
    const mockClient = new (DebuggAIServerClient as any)();
    // Simulate a hanging API call
    mockClient.findProjectByRepoName.mockImplementation(() => new Promise(() => {}));
    (DebuggAIServerClient as jest.Mock).mockImplementation(() => mockClient);

    const { resolveProjectContext } = await import('../../services/projectContext.js');
    const start = Date.now();
    const result = await resolveProjectContext();
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(9000);
    expect(elapsed).toBeLessThan(15000);
  }, 20000);
});
