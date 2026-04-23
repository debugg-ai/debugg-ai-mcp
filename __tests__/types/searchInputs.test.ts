/**
 * Schema validation tests for the new search_* + extended create/update inputs.
 * Proof point for bead ddq.
 *
 * Covered:
 *  - SearchProjectsInputSchema
 *  - SearchEnvironmentsInputSchema
 *  - SearchExecutionsInputSchema
 *  - Extended CreateProjectInputSchema (teamName/repoName fallback for uuids)
 *  - Extended CreateEnvironmentInputSchema (optional credentials seed)
 *  - Extended UpdateEnvironmentInputSchema (cred sub-actions)
 */

import {
  SearchProjectsInputSchema,
  SearchEnvironmentsInputSchema,
  SearchExecutionsInputSchema,
  CreateProjectInputSchema,
  CreateEnvironmentInputSchema,
  UpdateEnvironmentInputSchema,
} from '../../types/index.js';

const UUID = '00000000-0000-0000-0000-00000000000a';
const UUID2 = '00000000-0000-0000-0000-00000000000b';

describe('SearchProjectsInputSchema', () => {
  test('empty input OK (no filters)', () => {
    expect(SearchProjectsInputSchema.safeParse({}).success).toBe(true);
  });
  test('uuid filter OK', () => {
    expect(SearchProjectsInputSchema.safeParse({ uuid: UUID }).success).toBe(true);
  });
  test('q filter OK', () => {
    expect(SearchProjectsInputSchema.safeParse({ q: 'myapp' }).success).toBe(true);
  });
  test('both uuid and q — rejected (ambiguous)', () => {
    expect(SearchProjectsInputSchema.safeParse({ uuid: UUID, q: 'x' }).success).toBe(false);
  });
  test('invalid uuid rejected', () => {
    expect(SearchProjectsInputSchema.safeParse({ uuid: 'not-uuid' }).success).toBe(false);
  });
  test('page + pageSize', () => {
    expect(SearchProjectsInputSchema.safeParse({ q: 'x', page: 2, pageSize: 10 }).success).toBe(true);
  });
  test('unknown field rejected (strict)', () => {
    expect(SearchProjectsInputSchema.safeParse({ q: 'x', bogus: true }).success).toBe(false);
  });
});

describe('SearchEnvironmentsInputSchema', () => {
  test('empty input OK', () => {
    expect(SearchEnvironmentsInputSchema.safeParse({}).success).toBe(true);
  });
  test('uuid only', () => {
    expect(SearchEnvironmentsInputSchema.safeParse({ uuid: UUID }).success).toBe(true);
  });
  test('uuid + projectUuid OK (projectUuid is URL locator, not filter)', () => {
    expect(SearchEnvironmentsInputSchema.safeParse({ uuid: UUID, projectUuid: UUID2 }).success).toBe(true);
  });
  test('projectUuid + q', () => {
    expect(SearchEnvironmentsInputSchema.safeParse({ projectUuid: UUID, q: 'stage' }).success).toBe(true);
  });
  test('uuid + q rejected', () => {
    expect(SearchEnvironmentsInputSchema.safeParse({ uuid: UUID, q: 'x' }).success).toBe(false);
  });
});

describe('SearchExecutionsInputSchema', () => {
  test('uuid only', () => {
    expect(SearchExecutionsInputSchema.safeParse({ uuid: UUID }).success).toBe(true);
  });
  test('status + projectUuid', () => {
    expect(SearchExecutionsInputSchema.safeParse({ status: 'completed', projectUuid: UUID }).success).toBe(true);
  });
  test('uuid + status rejected', () => {
    expect(SearchExecutionsInputSchema.safeParse({ uuid: UUID, status: 'x' }).success).toBe(false);
  });
});

describe('CreateProjectInputSchema (name resolution)', () => {
  test('uuids only still work (backward compat)', () => {
    expect(CreateProjectInputSchema.safeParse({
      name: 'p', platform: 'web', teamUuid: UUID, repoUuid: UUID2,
    }).success).toBe(true);
  });
  test('names only work', () => {
    expect(CreateProjectInputSchema.safeParse({
      name: 'p', platform: 'web', teamName: 'Engineering', repoName: 'debugg-ai/app',
    }).success).toBe(true);
  });
  test('mixed: teamUuid + repoName', () => {
    expect(CreateProjectInputSchema.safeParse({
      name: 'p', platform: 'web', teamUuid: UUID, repoName: 'debugg-ai/app',
    }).success).toBe(true);
  });
  test('missing BOTH team fields rejected', () => {
    expect(CreateProjectInputSchema.safeParse({
      name: 'p', platform: 'web', repoUuid: UUID2,
    }).success).toBe(false);
  });
  test('missing BOTH repo fields rejected', () => {
    expect(CreateProjectInputSchema.safeParse({
      name: 'p', platform: 'web', teamUuid: UUID,
    }).success).toBe(false);
  });
  test('both teamUuid AND teamName rejected (ambiguous)', () => {
    expect(CreateProjectInputSchema.safeParse({
      name: 'p', platform: 'web', teamUuid: UUID, teamName: 'X', repoUuid: UUID2,
    }).success).toBe(false);
  });
});

describe('CreateEnvironmentInputSchema (credentials seed)', () => {
  test('no credentials still valid', () => {
    expect(CreateEnvironmentInputSchema.safeParse({
      name: 'staging', url: 'https://stage.example.com',
    }).success).toBe(true);
  });
  test('credentials array accepted', () => {
    expect(CreateEnvironmentInputSchema.safeParse({
      name: 'staging',
      url: 'https://stage.example.com',
      credentials: [
        { label: 'admin', username: 'a@x.com', password: 'pw', role: 'admin' },
        { label: 'guest', username: 'g@x.com', password: 'pw' },
      ],
    }).success).toBe(true);
  });
  test('credential missing required field rejected', () => {
    expect(CreateEnvironmentInputSchema.safeParse({
      name: 'staging',
      url: 'https://stage.example.com',
      credentials: [{ label: 'admin', username: 'a@x.com' }], // missing password
    }).success).toBe(false);
  });
});

describe('UpdateEnvironmentInputSchema (cred sub-actions)', () => {
  test('just uuid — no-op update still valid', () => {
    expect(UpdateEnvironmentInputSchema.safeParse({ uuid: UUID }).success).toBe(true);
  });
  test('env field patch only', () => {
    expect(UpdateEnvironmentInputSchema.safeParse({
      uuid: UUID, name: 'new-name', description: 'updated',
    }).success).toBe(true);
  });
  test('addCredentials alone', () => {
    expect(UpdateEnvironmentInputSchema.safeParse({
      uuid: UUID,
      addCredentials: [{ label: 'l', username: 'u', password: 'p' }],
    }).success).toBe(true);
  });
  test('updateCredentials alone', () => {
    expect(UpdateEnvironmentInputSchema.safeParse({
      uuid: UUID,
      updateCredentials: [{ uuid: UUID2, label: 'renamed' }],
    }).success).toBe(true);
  });
  test('removeCredentialIds alone', () => {
    expect(UpdateEnvironmentInputSchema.safeParse({
      uuid: UUID, removeCredentialIds: [UUID2],
    }).success).toBe(true);
  });
  test('combined sub-actions', () => {
    expect(UpdateEnvironmentInputSchema.safeParse({
      uuid: UUID,
      name: 'new',
      addCredentials: [{ label: 'l', username: 'u', password: 'p' }],
      updateCredentials: [{ uuid: UUID2, password: 'new-pw' }],
      removeCredentialIds: [UUID, UUID2],
    }).success).toBe(true);
  });
  test('addCredentials entry missing password rejected', () => {
    expect(UpdateEnvironmentInputSchema.safeParse({
      uuid: UUID,
      addCredentials: [{ label: 'l', username: 'u' }],
    }).success).toBe(false);
  });
  test('updateCredentials entry missing uuid rejected', () => {
    expect(UpdateEnvironmentInputSchema.safeParse({
      uuid: UUID,
      updateCredentials: [{ label: 'l' }],
    }).success).toBe(false);
  });
  test('removeCredentialIds with invalid uuid rejected', () => {
    expect(UpdateEnvironmentInputSchema.safeParse({
      uuid: UUID,
      removeCredentialIds: ['not-uuid'],
    }).success).toBe(false);
  });
});
