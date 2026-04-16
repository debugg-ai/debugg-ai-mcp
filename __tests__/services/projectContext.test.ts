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

  it('resolves project with environments and credentials', async () => {
    const { detectRepoName } = await import('../../utils/gitContext.js');
    (detectRepoName as jest.Mock).mockReturnValue('org/repo');

    const mockProject = { uuid: 'proj-1', name: 'My Project', slug: 'my-project' };
    const mockEnvs = {
      results: [
        { uuid: 'env-1', name: 'Production', url: 'https://app.test.com', isActive: true },
        { uuid: 'env-2', name: 'Inactive', url: '', isActive: false },
      ],
    };
    const mockCreds = {
      results: [
        { uuid: 'cred-1', label: 'admin', username: 'admin@test.com', role: 'admin', isActive: true },
      ],
    };

    const { DebuggAIServerClient } = await import('../../services/index.js');
    const mockClient = new (DebuggAIServerClient as any)();
    mockClient.findProjectByRepoName.mockResolvedValue(mockProject);
    mockClient.tx.get.mockImplementation(async (url: string) => {
      if (url.includes('/environments/') && url.includes('/credentials/')) return mockCreds;
      if (url.includes('/environments/')) return mockEnvs;
      return { results: [] };
    });
    (DebuggAIServerClient as jest.Mock).mockImplementation(() => mockClient);

    const { resolveProjectContext } = await import('../../services/projectContext.js');
    const result = await resolveProjectContext();

    expect(result).not.toBeNull();
    expect(result!.project.uuid).toBe('proj-1');
    // Only active environments
    expect(result!.environments).toHaveLength(1);
    expect(result!.environments[0].name).toBe('Production');
    expect(result!.environments[0].credentials).toHaveLength(1);
    expect(result!.environments[0].credentials[0].username).toBe('admin@test.com');
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
