/**
 * updateEnvironmentHandler cred-sub-actions — proof point for bead tid.
 *
 * Covers:
 *  - env fields only (backward compat)
 *  - addCredentials alone
 *  - updateCredentials alone
 *  - removeCredentialIds alone
 *  - combined all three sub-actions in one call
 *  - partial failure: some sub-actions fail, response has credentialWarnings
 *  - NO PASSWORD LEAK in response
 *  - execution order: remove → update → add (so freed labels can be reused)
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockUpdateEnvironment = jest.fn<(...args: any[]) => Promise<any>>();
const mockCreateCredential = jest.fn<(...args: any[]) => Promise<any>>();
const mockUpdateCredential = jest.fn<(...args: any[]) => Promise<any>>();
const mockDeleteCredential = jest.fn<(...args: any[]) => Promise<void>>();
const mockFindProjectByRepoName = jest.fn<(repo: string) => Promise<any>>();
const mockDetectRepoName = jest.fn<() => string | null>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    updateEnvironment: mockUpdateEnvironment,
    createCredential: mockCreateCredential,
    updateCredential: mockUpdateCredential,
    deleteCredential: mockDeleteCredential,
    findProjectByRepoName: mockFindProjectByRepoName,
  })),
}));

jest.unstable_mockModule('../../utils/gitContext.js', () => ({
  detectRepoName: mockDetectRepoName,
}));

let updateEnvironmentHandler: typeof import('../../handlers/updateEnvironmentHandler.js').updateEnvironmentHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/updateEnvironmentHandler.js');
  updateEnvironmentHandler = mod.updateEnvironmentHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };
const PROJECT_UUID = '11111111-1111-1111-1111-111111111111';
const ENV_UUID = '22222222-2222-2222-2222-222222222222';
const CRED_A = '33333333-3333-3333-3333-333333333333';
const CRED_B = '44444444-4444-4444-4444-444444444444';

const ENV_UPDATED = { uuid: ENV_UUID, name: 'env', url: 'https://x' };

describe('updateEnvironmentHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockUpdateEnvironment.mockResolvedValue(ENV_UPDATED);
  });

  describe('env fields only (backward compat)', () => {
    test('updates env description, does NOT touch creds', async () => {
      const res = await updateEnvironmentHandler({
        uuid: ENV_UUID, projectUuid: PROJECT_UUID,
        description: 'new desc',
      }, ctx);

      expect(mockUpdateEnvironment).toHaveBeenCalled();
      expect(mockCreateCredential).not.toHaveBeenCalled();
      expect(mockUpdateCredential).not.toHaveBeenCalled();
      expect(mockDeleteCredential).not.toHaveBeenCalled();
      const body = JSON.parse(res.content[0].text!);
      expect(body.updated).toBe(true);
      expect(body.environment.uuid).toBe(ENV_UUID);
    });

    test('no env field patch, no cred sub-actions: still succeeds (uuid-only no-op)', async () => {
      const res = await updateEnvironmentHandler({
        uuid: ENV_UUID, projectUuid: PROJECT_UUID,
      }, ctx);
      expect(res.isError).not.toBe(true);
    });
  });

  describe('addCredentials sub-action', () => {
    test('creates each credential; response has addedCredentials[]', async () => {
      mockCreateCredential
        .mockResolvedValueOnce({ uuid: 'new-1', label: 'x', username: 'x', role: null, environmentUuid: ENV_UUID })
        .mockResolvedValueOnce({ uuid: 'new-2', label: 'y', username: 'y', role: 'admin', environmentUuid: ENV_UUID });

      const res = await updateEnvironmentHandler({
        uuid: ENV_UUID, projectUuid: PROJECT_UUID,
        addCredentials: [
          { label: 'x', username: 'x', password: 'p' },
          { label: 'y', username: 'y', password: 'p', role: 'admin' },
        ],
      }, ctx);

      expect(mockCreateCredential).toHaveBeenCalledTimes(2);
      const body = JSON.parse(res.content[0].text!);
      expect(body.addedCredentials).toHaveLength(2);
      expect(body.addedCredentials[0]).toMatchObject({ uuid: 'new-1' });
      expect(body).not.toHaveProperty('credentialWarnings');
    });
  });

  describe('updateCredentials sub-action', () => {
    test('patches each credential by uuid; response has updatedCredentials[]', async () => {
      mockUpdateCredential.mockResolvedValueOnce({
        uuid: CRED_A, label: 'renamed', username: 'u', role: 'admin', environmentUuid: ENV_UUID, isActive: true,
      });

      const res = await updateEnvironmentHandler({
        uuid: ENV_UUID, projectUuid: PROJECT_UUID,
        updateCredentials: [{ uuid: CRED_A, label: 'renamed', role: 'admin' }],
      }, ctx);

      expect(mockUpdateCredential).toHaveBeenCalledWith(
        PROJECT_UUID, ENV_UUID, CRED_A, { label: 'renamed', role: 'admin' },
      );
      const body = JSON.parse(res.content[0].text!);
      expect(body.updatedCredentials).toHaveLength(1);
      expect(body.updatedCredentials[0]).toMatchObject({ uuid: CRED_A, label: 'renamed' });
    });
  });

  describe('removeCredentialIds sub-action', () => {
    test('deletes each cred by uuid; response has removedCredentialIds[]', async () => {
      mockDeleteCredential.mockResolvedValue(undefined);

      const res = await updateEnvironmentHandler({
        uuid: ENV_UUID, projectUuid: PROJECT_UUID,
        removeCredentialIds: [CRED_A, CRED_B],
      }, ctx);

      expect(mockDeleteCredential).toHaveBeenCalledTimes(2);
      const body = JSON.parse(res.content[0].text!);
      expect(body.removedCredentialIds).toEqual([CRED_A, CRED_B]);
    });
  });

  describe('combined sub-actions + execution order', () => {
    test('order: remove → update → add (so a removed label can be re-added)', async () => {
      const order: string[] = [];
      mockDeleteCredential.mockImplementation(async () => { order.push('delete'); });
      mockUpdateCredential.mockImplementation(async (_p, _e, uuid) => {
        order.push('update');
        return { uuid, label: 'l', username: 'u', role: null, environmentUuid: ENV_UUID, isActive: true };
      });
      mockCreateCredential.mockImplementation(async (_p, _e, seed) => {
        order.push('create');
        return { uuid: 'new', label: seed.label, username: seed.username, role: seed.role ?? null, environmentUuid: ENV_UUID };
      });

      await updateEnvironmentHandler({
        uuid: ENV_UUID, projectUuid: PROJECT_UUID,
        removeCredentialIds: [CRED_A],
        updateCredentials: [{ uuid: CRED_B, label: 'new-label' }],
        addCredentials: [{ label: 'fresh', username: 'f', password: 'p' }],
      }, ctx);

      expect(order).toEqual(['delete', 'update', 'create']);
    });
  });

  describe('partial failure', () => {
    test('one cred add fails: response has partial addedCredentials + credentialWarnings', async () => {
      mockCreateCredential
        .mockResolvedValueOnce({ uuid: 'a', label: 'a', username: 'a', role: null, environmentUuid: ENV_UUID })
        .mockRejectedValueOnce(new Error('duplicate label'));

      const res = await updateEnvironmentHandler({
        uuid: ENV_UUID, projectUuid: PROJECT_UUID,
        addCredentials: [
          { label: 'a', username: 'a', password: 'p' },
          { label: 'b', username: 'b', password: 'p' },
        ],
      }, ctx);

      const body = JSON.parse(res.content[0].text!);
      expect(body.addedCredentials).toHaveLength(1);
      expect(body.credentialWarnings).toHaveLength(1);
      expect(body.credentialWarnings[0]).toMatchObject({ op: 'add', label: 'b' });
    });

    test('update failure + remove failure: each surfaced distinctly in credentialWarnings', async () => {
      mockUpdateCredential.mockRejectedValueOnce(new Error('not authorized'));
      mockDeleteCredential.mockRejectedValueOnce(new Error('cred in use'));

      const res = await updateEnvironmentHandler({
        uuid: ENV_UUID, projectUuid: PROJECT_UUID,
        removeCredentialIds: [CRED_A],
        updateCredentials: [{ uuid: CRED_B, label: 'x' }],
      }, ctx);

      const body = JSON.parse(res.content[0].text!);
      expect(body.credentialWarnings).toHaveLength(2);
      const ops = body.credentialWarnings.map(w => w.op);
      expect(ops).toContain('update');
      expect(ops).toContain('remove');
    });
  });

  describe('NO PASSWORD LEAK', () => {
    test('addCredentials with password: response never contains the password', async () => {
      mockCreateCredential.mockResolvedValueOnce({
        uuid: 'c', label: 'l', username: 'u', role: null, environmentUuid: ENV_UUID,
      });

      const res = await updateEnvironmentHandler({
        uuid: ENV_UUID, projectUuid: PROJECT_UUID,
        addCredentials: [{ label: 'l', username: 'u', password: 'TOP-SECRET-PW-42' }],
      }, ctx);

      const raw = res.content[0].text!;
      expect(raw).not.toContain('TOP-SECRET-PW-42');
      expect(raw).not.toMatch(/"password"\s*:/);
    });
  });
});
