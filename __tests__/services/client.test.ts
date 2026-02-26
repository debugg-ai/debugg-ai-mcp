/**
 * DebuggAIServerClient tests.
 *
 * Covers:
 *  - init() wires up services
 *  - revokeNgrokKey API call
 *  - isMcpRequest interceptor injection
 */

import { jest } from '@jest/globals';

// ── Mock AxiosTransport ──────────────────────────────────────────────────────

const mockPost = jest.fn<() => Promise<unknown>>();
const mockGet = jest.fn<() => Promise<unknown>>();
const mockInterceptorUse = jest.fn();

jest.unstable_mockModule('../../utils/axiosTransport.js', () => {
  return {
    AxiosTransport: jest.fn().mockImplementation(() => ({
      post: mockPost,
      get: mockGet,
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

// ── revokeNgrokKey ───────────────────────────────────────────────────────────

describe('revokeNgrokKey', () => {
  test('POSTs to api/v1/ngrok/revoke/ with ngrokKeyId', async () => {
    const client = new DebuggAIServerClient('test-key');
    await client.init();
    await client.revokeNgrokKey('ak_123');
    expect(mockPost).toHaveBeenCalledWith('api/v1/ngrok/revoke/', { ngrokKeyId: 'ak_123' });
  });

  test('throws if called before init()', async () => {
    const client = new DebuggAIServerClient('test-key');
    await expect(client.revokeNgrokKey('ak_123')).rejects.toThrow('not initialized');
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
