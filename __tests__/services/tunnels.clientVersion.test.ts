/**
 * Provision sends client_version; error advice matches the server (platform-65o4).
 */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createTunnelsService } from '../../services/tunnels.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
const service = createTunnelsService({ post: mockPost } as any);

const GOOD = {
  tunnelId: 't', tunnelKey: 'k', keyId: 'i', expiresAt: '2030-01-01T00:00:00Z',
  transport: 'debugg', relayUrl: 'wss://api.debugg.ai/tunnel/v1/connect', tunnelDomain: 'tunnel.debugg.ai',
};

beforeEach(() => mockPost.mockReset());

test('provision body carries client_version equal to package.json version', async () => {
  mockPost.mockResolvedValue(GOOD);
  await service.provision();
  const body = mockPost.mock.calls[0][1] as any;
  expect(body.client_version).toBe(pkg.version);
  expect(body.client_version).toMatch(/^\d+\.\d+\.\d+/);
});

describe.each([
  ['ngrok transport', { ...GOOD, transport: 'ngrok' }],
  ['no relayUrl', { ...GOOD, relayUrl: undefined }],
])('%s error advice', (_name, resp) => {
  test('says update to @latest and restart, never pin 4.4.1', async () => {
    mockPost.mockResolvedValue(resp);
    const err: any = await service.provision().catch((e: any) => e);
    expect(err.message).not.toMatch(/4\.4\.1|[Pp]in @debugg/);
    expect(err.message).toContain('npx @debugg-ai/debugg-ai-mcp@latest');
    expect(err.message).toMatch(/restart/i);
    expect(err.message).toMatch(/out of date/i);
    expect(err.message).toMatch(/report/i);
  });
});
