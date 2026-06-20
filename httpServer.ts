/**
 * Streamable HTTP transport + OAuth Resource Server (epic lybfq).
 *
 * Opt-in remote transport: `DEBUGGAI_MCP_TRANSPORT=http` (stdio stays default).
 * Stateless (no session id) so it scales behind a plain load balancer.
 *
 * Auth model — the MCP server is an OAuth **Resource Server**:
 *   - Every /mcp request must carry `Authorization: Bearer <token>`.
 *   - The token is stashed per-request (AsyncLocalStorage) and used as the
 *     backend credential; api.debugg.ai is the real validator (a bad token 401s
 *     on the first backend call). No token verification keys live here.
 *   - Missing token → 401 + `WWW-Authenticate: Bearer resource_metadata=...`,
 *     and we serve RFC 9728 metadata at /.well-known/oauth-protected-resource
 *     pointing clients at auth.debugg.ai to run the OAuth flow.
 *
 * Deployment note: set DEBUGGAI_TOKEN_TYPE=bearer so the backend client forwards
 * the OAuth token as `Authorization: Bearer` (not `Token`).
 */

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { runWithApiKey } from './utils/requestContext.js';
import { Logger } from './utils/index.js';

export interface HttpServerOptions {
  port: number;
  buildServer: () => Server;
  logger: Logger;
}

const PUBLIC_URL = (process.env.DEBUGGAI_MCP_PUBLIC_URL || 'https://mcp.debugg.ai').replace(/\/+$/, '');
const OAUTH_ISSUER = (process.env.DEBUGGAI_OAUTH_ISSUER || 'https://auth.debugg.ai').replace(/\/+$/, '');
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** RFC 9728 protected-resource metadata: tells clients which AS issues tokens. */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: PUBLIC_URL,
    authorization_servers: [OAUTH_ISSUER],
    bearer_methods_supported: ['header'],
  };
}

/** Extract the token from `Authorization: Bearer <t>` (or `Token <t>`). */
export function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^(?:Bearer|Token)\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1].trim() : undefined;
}

function sendJson(res: ServerResponse, code: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

function unauthorized(res: ServerResponse): void {
  const metadataUrl = `${PUBLIC_URL}${RESOURCE_METADATA_PATH}`;
  sendJson(
    res,
    401,
    { error: 'unauthorized', error_description: 'Missing or invalid bearer token; authenticate via the linked authorization server.' },
    { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"` },
  );
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    let aborted = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES && !aborted) {
        aborted = true;
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      if (aborted) return;
      if (!data) return resolve(undefined);
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** Start the stateless Streamable HTTP server. Resolves to the listening server. */
export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServer> {
  const { port, buildServer, logger } = opts;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;

    // ECS / LB health check — no auth.
    if (path === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok' });
    }

    // RFC 9728 protected-resource metadata — public discovery, no auth.
    if (path === RESOURCE_METADATA_PATH && req.method === 'GET') {
      return sendJson(res, 200, protectedResourceMetadata());
    }

    if (path === MCP_PATH) {
      const token = bearerToken(req.headers['authorization']);
      if (!token) {
        logger.info('HTTP MCP request without bearer token → 401');
        return unauthorized(res);
      }

      let body: unknown;
      if (req.method === 'POST') {
        try {
          body = await readJsonBody(req);
        } catch {
          return sendJson(res, 400, { error: 'invalid_request', error_description: 'Request body must be valid JSON' });
        }
      }

      // Stateless: a fresh server + transport per request, scoped to this
      // request's bearer token via AsyncLocalStorage (so config.api.key resolves
      // to it for every backend call made while handling this request).
      const srv = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
        srv.close().catch(() => {});
      });
      try {
        await srv.connect(transport);
        await runWithApiKey(token, () => transport.handleRequest(req, res, body));
      } catch (error) {
        logger.error('HTTP MCP request failed', { error: error instanceof Error ? error.message : String(error) });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      }
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  logger.info('HTTP transport listening', { port, resource: PUBLIC_URL, authorizationServer: OAUTH_ISSUER });
  return httpServer;
}
