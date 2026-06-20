/**
 * HTTP transport + OAuth Resource Server (epic lybfq).
 * Unit: bearer extraction + RFC 9728 metadata.
 * Integration: routing, the 401 auth gate (+ WWW-Authenticate), and an
 * authenticated initialize passing the gate into the MCP transport.
 */

import { jest } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHttpServer, bearerToken, protectedResourceMetadata } from '../httpServer.js';

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } } as any;

function buildStubServer(): Server {
  const srv = new Server({ name: 'stub', version: '1' }, { capabilities: { tools: {} } });
  srv.setRequestHandler(ListToolsRequestSchema as any, async () => ({ tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }));
  return srv;
}

describe('bearerToken', () => {
  test('extracts Bearer and Token schemes, case-insensitive', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer xyz')).toBe('xyz');
    expect(bearerToken('Token kkk')).toBe('kkk');
  });
  test('returns undefined for missing/garbage headers', () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('')).toBeUndefined();
    expect(bearerToken('Basic abc')).toBeUndefined();
  });
});

describe('protectedResourceMetadata (RFC 9728)', () => {
  test('advertises the resource + authorization server', () => {
    const m = protectedResourceMetadata();
    expect(typeof m.resource).toBe('string');
    expect(Array.isArray(m.authorization_servers)).toBe(true);
    expect((m.authorization_servers as string[])[0]).toContain('auth.debugg.ai');
    expect(m.bearer_methods_supported).toEqual(['header']);
  });
});

describe('HTTP transport (integration)', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  let base: string;

  beforeAll(async () => {
    server = await startHttpServer({ port: 0, buildServer: buildStubServer, logger: noopLogger });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('GET /health → 200 {status:ok}', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
  });

  test('GET /.well-known/oauth-protected-resource → 200 metadata', async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(r.status).toBe(200);
    const m = await r.json();
    expect(m.authorization_servers[0]).toContain('auth.debugg.ai');
  });

  test('POST /mcp without bearer → 401 + WWW-Authenticate', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } } }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate') || '').toContain('resource_metadata=');
  });

  test('POST /mcp with bearer + initialize → passes auth gate (not 401)', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } } }),
    });
    expect(r.status).not.toBe(401);
    expect(r.status).toBeLessThan(500);
    const text = await r.text();
    expect(text).toMatch(/stub|serverInfo|result|jsonrpc/);
  });

  test('unknown path → 404', async () => {
    const r = await fetch(`${base}/nope`);
    expect(r.status).toBe(404);
  });
});
