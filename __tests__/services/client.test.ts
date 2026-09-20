/**
 * DebuggAIServerClient tests.
 *
 * Covers:
 *  - init() wires up services
 *  - tunnel provisioning wiring
 *  - isMcpRequest interceptor injection
 */

import { jest } from '@jest/globals';

// ── Mock AxiosTransport ──────────────────────────────────────────────────────

const mockPost = jest.fn<() => Promise<unknown>>();
const mockGet = jest.fn<() => Promise<unknown>>();
const mockPatch = jest.fn<() => Promise<unknown>>();
const mockInterceptorUse = jest.fn();

jest.unstable_mockModule('../../utils/axiosTransport.js', () => {
  return {
    AxiosTransport: jest.fn().mockImplementation(() => ({
      post: mockPost,
      get: mockGet,
      patch: mockPatch,
      axios: {
        interceptors: {
          request: { use: mockInterceptorUse },
        },
      },
    })),
  };
});

// ── Import module under test (after mocks) ───────────────────────────────────

let DebuggAIServerClient: typeof import('../../services/index.js').DebuggAIServerClient;
let AxiosTransport: jest.Mock;

beforeAll(async () => {
  const mod = await import('../../services/index.js');
  DebuggAIServerClient = mod.DebuggAIServerClient;
  const txMod = await import('../../utils/axiosTransport.js');
  AxiosTransport = txMod.AxiosTransport as unknown as jest.Mock;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockResolvedValue({});
  mockGet.mockResolvedValue({});
  mockPatch.mockResolvedValue({});
});

// ── init() ───────────────────────────────────────────────────────────────────

describe('init()', () => {
  test('creates workflows and tunnels services', async () => {
    const client = new DebuggAIServerClient('test-key');
    expect(client.workflows).toBeUndefined();
    expect(client.tunnels).toBeUndefined();
    await client.init();
    expect(client.workflows).toBeDefined();
    expect(client.tunnels).toBeDefined();
  });
});

// ── isMcpRequest interceptor ─────────────────────────────────────────────────

describe('isMcpRequest interceptor', () => {
  async function getInterceptor() {
    const client = new DebuggAIServerClient('test-key');
    await client.init();
    // The interceptor is registered in the DebuggTransport constructor.
    // AxiosTransport mock's instance has axios.interceptors.request.use called.
    const useCall = mockInterceptorUse.mock.calls[0];
    return useCall[0] as (config: any) => any;
  }

  test('adds isMcpRequest to GET params', async () => {
    const interceptor = await getInterceptor();
    const config = { method: 'get', params: {} };
    const result = interceptor(config);
    expect(result.params.isMcpRequest).toBe(true);
  });

  test('adds isMcpRequest to POST body', async () => {
    const interceptor = await getInterceptor();
    const config = { method: 'post', data: { purpose: 'workflow' } };
    const result = interceptor(config);
    expect(result.data.isMcpRequest).toBe(true);
    expect(result.data.purpose).toBe('workflow'); // original data preserved
  });

  test('creates body when POST has no data', async () => {
    const interceptor = await getInterceptor();
    const config = { method: 'post', data: undefined };
    const result = interceptor(config);
    expect(result.data).toEqual({ isMcpRequest: true });
  });
});

// ── environment authorizedCredentialHosts (bead q4d4) ────────────────────────
// Bodies are built camelCase here; the real AxiosTransport snake_cases them on
// the way out and camelCases responses on the way in. The wire name the backend
// agreed to (sentinal-oj7dp.23) is pinned below against the real converter.

describe('environment authorizedCredentialHosts', () => {
  const P = 'proj-1';
  const E = 'env-1';

  test('the wire name is authorized_credential_hosts in both directions', async () => {
    const { objToSnakeCase, objToCamelCase } = await import('../../utils/objectNaming.js');
    expect(objToSnakeCase({ authorizedCredentialHosts: ['auth.idp.example'] }))
      .toEqual({ authorized_credential_hosts: ['auth.idp.example'] });
    expect(objToCamelCase({ authorized_credential_hosts: ['auth.idp.example'] }))
      .toEqual({ authorizedCredentialHosts: ['auth.idp.example'] });
  });

  test('createEnvironment sends the hosts and returns the echo', async () => {
    mockPost.mockResolvedValueOnce({ uuid: E, name: 'n', url: 'https://app', isActive: true, authorizedCredentialHosts: ['auth.idp.example'] });
    const client = new DebuggAIServerClient('k');
    await client.init();
    const env = await client.createEnvironment(P, { name: 'n', url: 'https://app', authorizedCredentialHosts: ['auth.idp.example'] });
    expect(mockPost).toHaveBeenCalledWith(
      `api/v1/projects/${P}/environments/`,
      expect.objectContaining({ authorizedCredentialHosts: ['auth.idp.example'] }),
    );
    expect(env.authorizedCredentialHosts).toEqual(['auth.idp.example']);
  });

  test('updateEnvironment sends the hosts (even []) and returns the echo', async () => {
    mockPatch.mockResolvedValueOnce({ name: 'n', url: 'https://app', isActive: true, authorizedCredentialHosts: [] });
    const client = new DebuggAIServerClient('k');
    await client.init();
    const env = await client.updateEnvironment(P, E, { authorizedCredentialHosts: [] });
    expect(mockPatch).toHaveBeenCalledWith(
      `api/v1/projects/${P}/environments/${E}/`,
      { authorizedCredentialHosts: [] },
    );
    expect(env.authorizedCredentialHosts).toEqual([]);
  });

  test('updateEnvironment leaves the field out of the body when not asked', async () => {
    const client = new DebuggAIServerClient('k');
    await client.init();
    await client.updateEnvironment(P, E, { name: 'renamed' });
    expect(mockPatch).toHaveBeenCalledWith(`api/v1/projects/${P}/environments/${E}/`, { name: 'renamed' });
  });

  test('a response without the field OMITS it rather than claiming an empty list', async () => {
    mockPatch.mockResolvedValueOnce({ name: 'n', url: 'https://app', isActive: true });
    mockGet.mockResolvedValueOnce({ uuid: E, name: 'n', url: 'https://app', isActive: true });
    const client = new DebuggAIServerClient('k');
    await client.init();
    const patched = await client.updateEnvironment(P, E, { authorizedCredentialHosts: ['auth.idp.example'] });
    const got = await client.getEnvironment(P, E);
    expect(patched).not.toHaveProperty('authorizedCredentialHosts');
    expect(got).not.toHaveProperty('authorizedCredentialHosts');
  });

  test('getEnvironment and listEnvironmentsPaginated return the field when the backend has it', async () => {
    mockGet
      .mockResolvedValueOnce({ uuid: E, name: 'n', url: 'https://app', isActive: true, authorizedCredentialHosts: ['auth.idp.example'] })
      .mockResolvedValueOnce({ count: 2, next: null, results: [
        { uuid: E, name: 'n', url: 'https://app', isActive: true, authorizedCredentialHosts: ['auth.idp.example'] },
        { uuid: 'env-2', name: 'm', url: 'https://other', isActive: true },
      ] });
    const client = new DebuggAIServerClient('k');
    await client.init();
    const got = await client.getEnvironment(P, E);
    expect(got.authorizedCredentialHosts).toEqual(['auth.idp.example']);
    const { environments } = await client.listEnvironmentsPaginated(P, { page: 1, pageSize: 20 });
    expect(environments[0].authorizedCredentialHosts).toEqual(['auth.idp.example']);
    expect(environments[1]).not.toHaveProperty('authorizedCredentialHosts');
  });
});
