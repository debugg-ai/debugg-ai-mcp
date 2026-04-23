/**
 * createEnvironmentHandler unit tests — proof point for bead 65m.
 *
 * Covers:
 *  - env-only path (no credentials field): no createCredential call, response identical to old behavior
 *  - env + credentials seed: env created, then N createCredential calls; response includes credentials array
 *  - partial-failure path: env created, 2 of 3 creds fail; response has credentials[] + credentialWarnings[]
 *  - NO PASSWORD LEAK: even on success, response.credentials[*] never contains password
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockCreateEnvironment = jest.fn<(...args: any[]) => Promise<any>>();
const mockCreateCredential = jest.fn<(...args: any[]) => Promise<any>>();
const mockFindProjectByRepoName = jest.fn<(repo: string) => Promise<any>>();
const mockDetectRepoName = jest.fn<() => string | null>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    createEnvironment: mockCreateEnvironment,
    createCredential: mockCreateCredential,
    findProjectByRepoName: mockFindProjectByRepoName,
  })),
}));

jest.unstable_mockModule('../../utils/gitContext.js', () => ({
  detectRepoName: mockDetectRepoName,
}));

let createEnvironmentHandler: typeof import('../../handlers/createEnvironmentHandler.js').createEnvironmentHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/createEnvironmentHandler.js');
  createEnvironmentHandler = mod.createEnvironmentHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };
const PROJECT_UUID = '11111111-1111-1111-1111-111111111111';
const ENV_UUID = '22222222-2222-2222-2222-222222222222';

const CREATED_ENV = { uuid: ENV_UUID, name: 'staging', url: 'https://stage' };

describe('createEnvironmentHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockCreateEnvironment.mockResolvedValue(CREATED_ENV);
  });

  describe('env-only path (no credentials)', () => {
    test('creates env, does NOT call createCredential', async () => {
      const res = await createEnvironmentHandler({
        name: 'staging', url: 'https://stage', projectUuid: PROJECT_UUID,
      }, ctx);

      expect(mockCreateEnvironment).toHaveBeenCalled();
      expect(mockCreateCredential).not.toHaveBeenCalled();
      const body = JSON.parse(res.content[0].text!);
      expect(body.created).toBe(true);
      expect(body.environment.uuid).toBe(ENV_UUID);
      expect(body).not.toHaveProperty('credentials');
    });
  });

  describe('env + credentials seed', () => {
    test('creates env, then creates each credential; response has credentials inline', async () => {
      mockCreateCredential
        .mockResolvedValueOnce({ uuid: 'c1', label: 'admin', username: 'a', role: 'admin', environmentUuid: ENV_UUID })
        .mockResolvedValueOnce({ uuid: 'c2', label: 'guest', username: 'g', role: null, environmentUuid: ENV_UUID });

      const res = await createEnvironmentHandler({
        name: 'staging', url: 'https://stage', projectUuid: PROJECT_UUID,
        credentials: [
          { label: 'admin', username: 'a', password: 'pw-admin', role: 'admin' },
          { label: 'guest', username: 'g', password: 'pw-guest' },
        ],
      }, ctx);

      expect(mockCreateCredential).toHaveBeenCalledTimes(2);
      const body = JSON.parse(res.content[0].text!);
      expect(body.credentials).toHaveLength(2);
      expect(body.credentials[0]).toMatchObject({ uuid: 'c1', label: 'admin' });
      expect(body).not.toHaveProperty('credentialWarnings');
    });

    test('NO PASSWORD LEAK: credentials array does not contain password field', async () => {
      mockCreateCredential.mockResolvedValueOnce({
        uuid: 'c1', label: 'admin', username: 'a', role: 'admin', environmentUuid: ENV_UUID,
      });

      const res = await createEnvironmentHandler({
        name: 'staging', url: 'https://stage', projectUuid: PROJECT_UUID,
        credentials: [{ label: 'admin', username: 'a', password: 'super-secret-pw-123' }],
      }, ctx);

      const raw = res.content[0].text!;
      expect(raw).not.toContain('super-secret-pw-123');
      expect(raw).not.toMatch(/"password"\s*:/);
    });
  });

  describe('partial failure on cred seed', () => {
    test('env succeeds + 1 of 3 creds fails: response has credentials + credentialWarnings', async () => {
      mockCreateCredential
        .mockResolvedValueOnce({ uuid: 'c1', label: 'a', username: 'a', role: null, environmentUuid: ENV_UUID })
        .mockRejectedValueOnce(new Error('duplicate label'))
        .mockResolvedValueOnce({ uuid: 'c3', label: 'c', username: 'c', role: null, environmentUuid: ENV_UUID });

      const res = await createEnvironmentHandler({
        name: 'staging', url: 'https://stage', projectUuid: PROJECT_UUID,
        credentials: [
          { label: 'a', username: 'a', password: 'p' },
          { label: 'b', username: 'b', password: 'p' },
          { label: 'c', username: 'c', password: 'p' },
        ],
      }, ctx);

      const body = JSON.parse(res.content[0].text!);
      expect(body.credentials).toHaveLength(2);
      expect(body.credentialWarnings).toHaveLength(1);
      expect(body.credentialWarnings[0]).toMatchObject({ label: 'b' });
      expect(body.credentialWarnings[0].error).toMatch(/duplicate/);
    });
  });
});
