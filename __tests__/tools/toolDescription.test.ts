import { buildToolDescription } from '../../tools/testPageChanges.js';
import type { ProjectContext } from '../../services/projectContext.js';

describe('buildToolDescription', () => {
  it('returns base description when no project context', () => {
    const desc = buildToolDescription(null);
    expect(desc).toContain('Give an AI agent eyes');
    expect(desc).toContain('LOCALHOST SUPPORT');
    expect(desc).not.toContain('DETECTED PROJECT');
  });

  it('shows project with no credentials', () => {
    const ctx: ProjectContext = {
      repoName: 'org/repo',
      project: { uuid: 'p1', name: 'My App', slug: 'my-app' },
      environments: [
        { uuid: 'e1', name: 'Production', url: 'https://app.test.com', credentials: [] },
      ],
    };
    const desc = buildToolDescription(ctx);
    expect(desc).toContain('DETECTED PROJECT: "My App"');
    expect(desc).toContain('No credentials configured');
  });

  it('lists environments and credentials when available', () => {
    const ctx: ProjectContext = {
      repoName: 'org/repo',
      project: { uuid: 'p1', name: 'My App', slug: 'my-app' },
      environments: [
        {
          uuid: 'env-1',
          name: 'localhost',
          url: 'http://localhost:3000',
          credentials: [
            { uuid: 'cred-1', label: 'admin', username: 'admin@test.com', role: 'admin', environmentName: 'localhost', environmentUuid: 'env-1' },
            { uuid: 'cred-2', label: 'viewer', username: 'viewer@test.com', role: 'viewer', environmentName: 'localhost', environmentUuid: 'env-1' },
          ],
        },
        {
          uuid: 'env-2',
          name: 'Production',
          url: 'https://app.test.com',
          credentials: [
            { uuid: 'cred-3', label: 'qa', username: 'qa@test.com', role: null, environmentName: 'Production', environmentUuid: 'env-2' },
          ],
        },
      ],
    };
    const desc = buildToolDescription(ctx);
    expect(desc).toContain('DETECTED PROJECT: "My App"');
    expect(desc).toContain('AVAILABLE ENVIRONMENTS & CREDENTIALS');
    expect(desc).toContain('Environment: "localhost" (env-1)');
    expect(desc).toContain('"admin" (cred-1) — user: admin@test.com, role: admin');
    expect(desc).toContain('"viewer" (cred-2) — user: viewer@test.com, role: viewer');
    expect(desc).toContain('Environment: "Production" (env-2)');
    expect(desc).toContain('"qa" (cred-3) — user: qa@test.com');
    // No role for qa
    expect(desc).not.toContain('qa@test.com, role:');
    expect(desc).toContain('pass environmentId and credentialId');
  });

  it('skips environments with zero credentials in the credentials section', () => {
    const ctx: ProjectContext = {
      repoName: 'org/repo',
      project: { uuid: 'p1', name: 'App', slug: 'app' },
      environments: [
        { uuid: 'e1', name: 'empty-env', url: '', credentials: [] },
        {
          uuid: 'e2', name: 'has-creds', url: 'https://test.com',
          credentials: [{ uuid: 'c1', label: 'me', username: 'me@test.com', role: null, environmentName: 'has-creds', environmentUuid: 'e2' }],
        },
      ],
    };
    const desc = buildToolDescription(ctx);
    expect(desc).not.toContain('empty-env');
    expect(desc).toContain('has-creds');
  });
});
