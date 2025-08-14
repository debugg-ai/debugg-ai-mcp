/**
 * Mock configuration for testing
 */
import { Config } from '../../config/index.js';

export const createMockConfig = (overrides: Partial<Config> = {}): Config => {
  return {
    server: {
      name: 'DebuggAI MCP Server',
      version: '0.1.1',
    },
    api: {
      key: 'test-api-key-for-testing',
      baseUrl: undefined,
    },
    auth: {
      testUsername: 'test@example.com',
      testPassword: 'test-password',
    },
    defaults: {
      localPort: 3000,
      repoName: 'test-repo',
      branchName: 'test-branch',
      repoPath: '/test/repo/path',
      filePath: '/test/file/path',
    },
    logging: {
      level: 'error',
      format: 'simple',
    },
    ...overrides,
  };
};

export const mockValidConfig = createMockConfig();

export const mockConfigWithApiKey = createMockConfig({
  api: {
    key: 'valid-api-key-12345',
  },
});