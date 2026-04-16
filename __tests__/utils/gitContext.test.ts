import { jest } from '@jest/globals';

// Mock child_process before importing gitContext
jest.unstable_mockModule('child_process', () => ({
  execSync: jest.fn(),
}));

let detectRepoName: () => string | null;
let mockedExecSync: jest.Mock;

beforeEach(async () => {
  jest.resetModules();
  const cp = await import('child_process');
  mockedExecSync = cp.execSync as unknown as jest.Mock;
  mockedExecSync.mockReset();
  const mod = await import('../../utils/gitContext.js');
  detectRepoName = mod.detectRepoName;
});

describe('detectRepoName', () => {
  it('parses HTTPS origin URL', () => {
    mockedExecSync.mockReturnValue('https://github.com/debugg-ai/react-web-app.git\n');
    expect(detectRepoName()).toBe('debugg-ai/react-web-app');
  });

  it('parses SSH origin URL', () => {
    mockedExecSync.mockReturnValue('git@github.com:debugg-ai/react-web-app.git\n');
    expect(detectRepoName()).toBe('debugg-ai/react-web-app');
  });

  it('parses HTTPS without .git suffix', () => {
    mockedExecSync.mockReturnValue('https://github.com/my-org/my-repo\n');
    expect(detectRepoName()).toBe('my-org/my-repo');
  });

  it('returns null when git is not installed', () => {
    mockedExecSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(detectRepoName()).toBeNull();
  });

  it('returns null when not in a git repo', () => {
    mockedExecSync.mockImplementation(() => { throw new Error('fatal: not a git repository'); });
    expect(detectRepoName()).toBeNull();
  });

  it('returns null when no remote configured', () => {
    mockedExecSync.mockImplementation(() => { throw new Error('fatal: No such remote'); });
    expect(detectRepoName()).toBeNull();
  });

  it('caches result across calls', () => {
    mockedExecSync.mockReturnValue('https://github.com/a/b.git\n');
    detectRepoName();
    detectRepoName();
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  it('uses 2s timeout and pipes stdout only', () => {
    mockedExecSync.mockReturnValue('https://github.com/a/b.git\n');
    detectRepoName();
    expect(mockedExecSync).toHaveBeenCalledWith('git remote get-url origin', {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });
});
