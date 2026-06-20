/**
 * MCP Resources (epic pglam).
 *
 * Exposes the read-only entities (projects / environments / executions) as
 * addressable resources so clients can browse and @-mention them as context
 * instead of (or alongside) calling the `project`/`environment`/`executions`
 * tools. Reads reuse the exact tool handlers — same data, same auth, no drift.
 *
 *   Collections (resources/list):     debugg-ai://projects | environments | executions
 *   Items (resources/templates/list): debugg-ai://project/{uuid}
 *                                     debugg-ai://environment/{uuid}
 *                                     debugg-ai://execution/{uuid}
 *
 * Resources are additive: clients that don't support the capability simply
 * keep using the tools.
 */

import { config } from '../config/index.js';
import {
  MCPError,
  MCPErrorCode,
  ToolContext,
  ToolResponse,
  ProjectInput,
  EnvironmentInput,
  ExecutionsInput,
} from '../types/index.js';
import { projectHandler } from './projectHandler.js';
import { environmentHandler } from './environmentHandler.js';
import { executionsHandler } from './executionsHandler.js';

const SCHEME = 'debugg-ai';
const JSON_MIME = 'application/json';

/** Concrete collection resources returned by resources/list. */
export const RESOURCE_COLLECTIONS = [
  {
    uri: `${SCHEME}://projects`,
    name: 'projects',
    title: 'DebuggAI Projects',
    description: 'All projects visible to this API key (first page).',
    mimeType: JSON_MIME,
  },
  {
    uri: `${SCHEME}://environments`,
    name: 'environments',
    title: 'DebuggAI Environments',
    description: 'Environments for the auto-detected project (credentials redacted).',
    mimeType: JSON_MIME,
  },
  {
    uri: `${SCHEME}://executions`,
    name: 'executions',
    title: 'DebuggAI Executions',
    description: 'Recent workflow executions (first page).',
    mimeType: JSON_MIME,
  },
];

/** URI templates returned by resources/templates/list. */
export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: `${SCHEME}://project/{uuid}`,
    name: 'project',
    title: 'DebuggAI Project',
    description: 'A single project by UUID, with full detail.',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: `${SCHEME}://environment/{uuid}`,
    name: 'environment',
    title: 'DebuggAI Environment',
    description: 'A single environment by UUID, with credentials inline (passwords redacted).',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: `${SCHEME}://execution/{uuid}`,
    name: 'execution',
    title: 'DebuggAI Execution',
    description: 'A single execution by UUID, with full node detail + artifact links.',
    mimeType: JSON_MIME,
  },
];

function readContext(): ToolContext {
  return { timestamp: new Date() };
}

/** Pull the JSON payload that every entity handler emits as its single text block. */
function payloadText(res: ToolResponse): string {
  const text = res.content?.find((c) => c.type === 'text')?.text;
  return typeof text === 'string' ? text : '{}';
}

// debugg-ai://<kind>            (collection)
// debugg-ai://<kind>/<uuid>     (item)
const URI_RE = new RegExp(`^${SCHEME}://([a-z]+)(?:/([^/?#]+))?$`);

/**
 * Resolve a debugg-ai:// resource URI by dispatching to the matching tool
 * handler and wrapping its JSON payload as a resource content block.
 */
export async function readResource(uri: string): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  if (!config.api.key) {
    throw new MCPError(
      MCPErrorCode.CONFIGURATION_ERROR,
      'DEBUGGAI_API_KEY is not set. Configure it in your MCP server registration. Get a key at https://debugg.ai.',
      { missingEnvVars: ['DEBUGGAI_API_KEY'] },
    );
  }

  const match = URI_RE.exec(uri);
  if (!match) {
    throw new MCPError(MCPErrorCode.INVALID_PARAMS, `Unrecognized resource URI: ${uri}`);
  }
  const [, kind, id] = match;
  const ctx = readContext();

  const requireId = (): string => {
    if (!id) {
      throw new MCPError(MCPErrorCode.INVALID_PARAMS, `Resource ${uri} requires a UUID: ${SCHEME}://${kind}/{uuid}`);
    }
    return id;
  };

  let res: ToolResponse;
  switch (kind) {
    case 'projects':
      res = await projectHandler({ action: 'list' } as ProjectInput, ctx);
      break;
    case 'project':
      res = await projectHandler({ action: 'get', uuid: requireId() } as ProjectInput, ctx);
      break;
    case 'environments':
      res = await environmentHandler({ action: 'list' } as EnvironmentInput, ctx);
      break;
    case 'environment':
      res = await environmentHandler({ action: 'get', uuid: requireId() } as EnvironmentInput, ctx);
      break;
    case 'executions':
      res = await executionsHandler({ action: 'list' } as ExecutionsInput, ctx);
      break;
    case 'execution':
      res = await executionsHandler({ action: 'get', uuid: requireId() } as ExecutionsInput, ctx);
      break;
    default:
      throw new MCPError(MCPErrorCode.INVALID_PARAMS, `Unknown resource kind "${kind}" in ${uri}`);
  }

  return { contents: [{ uri, mimeType: JSON_MIME, text: payloadText(res) }] };
}
