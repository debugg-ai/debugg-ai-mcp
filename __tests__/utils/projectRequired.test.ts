import { projectRequiredMessage } from '../../utils/projectRequired.js';

describe('projectRequiredMessage (platform-y2ob.2)', () => {
  test('no repo: says what was observed and names projectUuid + repoName', () => {
    const m = projectRequiredMessage(null);
    expect(m).toContain('not a git repo and no repoName was passed');
    expect(m).toContain('`projectUuid`');
    expect(m).toContain('`repoName`');
    expect(m).not.toContain('No git repository detected');
  });
  test('unlinked repo: names the repo', () => {
    expect(projectRequiredMessage('acme/x')).toContain('git repo "acme/x"');
  });
});

describe('projectRequiredMessage without projectUuid support', () => {
  it('does not tell the caller to pass projectUuid', () => {
    const m = projectRequiredMessage(null, false);
    expect(m).not.toContain('projectUuid');
    expect(m).toContain('repoName');
    expect(m).toContain('environmentId');
  });
});
