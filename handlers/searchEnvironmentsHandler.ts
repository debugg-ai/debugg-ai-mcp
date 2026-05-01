/**
 * search_environments handler (bead 5kw)
 *
 * Absorbs list_environments + get_environment + all credential search.
 * Each environment in the response has its credentials expanded inline.
 *
 * Modes:
 *   uuid mode: {uuid, projectUuid?} → {filter:{uuid}, project, pageInfo:{totalCount:1,...},
 *                                      environments:[{...env, credentials:[...]}]}
 *   filter mode: {projectUuid?, q?, page?, pageSize?} → paginated list, creds inline per env
 *
 * Invariants:
 *   - NEVER returns a password field anywhere in the response (defensive strip at handler edge)
 *   - Git-fallback for projectUuid: detectRepoName() → findProjectByRepoName(); NoProjectResolved if both fail
 *   - NotFound on unknown uuid returns isError:true
 */

import {
  SearchEnvironmentsInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';
import { toPaginationParams, makePageInfo } from '../utils/pagination.js';

const logger = new Logger({ module: 'searchEnvironmentsHandler' });

type SafeCredential = { uuid: string; label: string; username: string; role: string | null; environmentUuid?: string };

function stripPassword(cred: any): SafeCredential {
  // Defensive: take only known-safe keys. Never spread the source.
  return {
    uuid: cred.uuid,
    label: cred.label,
    username: cred.username,
    role: cred.role ?? null,
    ...(cred.environmentUuid ? { environmentUuid: cred.environmentUuid } : {}),
  };
}

function notFound(uuid: string): ToolResponse {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: 'NotFound', message: `Environment ${uuid} not found.`, uuid }, null, 2),
    }],
    isError: true,
  };
}

function noProjectResolved(pagination: { page: number; pageSize: number }, reason: string): ToolResponse {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'NoProjectResolved',
        message: reason,
        pageInfo: makePageInfo(pagination.page, pagination.pageSize, 0, null),
        environments: [],
      }, null, 2),
    }],
  };
}

export async function searchEnvironmentsHandler(
  input: SearchEnvironmentsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  const pagination = toPaginationParams({ page: input.page, pageSize: input.pageSize });
  logger.toolStart('search_environments', { ...input, ...pagination });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    // ── Resolve projectUuid ──
    // Bead gb4n: when projectUuid is provided directly (caller skips git
    // auto-resolution), `name` and `repoName` are unknown. OMIT those fields
    // rather than emitting nulls — null fields surprised callers and
    // muddied the contract. If a caller needs them, they fetch via
    // search_projects.
    let projectUuid = input.projectUuid;
    let project: { uuid: string; name?: string; repoName?: string } | null = null;

    if (!projectUuid) {
      const repoName = detectRepoName();
      if (!repoName) {
        return noProjectResolved(pagination,
          'No git repo detected and no projectUuid provided. Pass projectUuid (get via search_projects) or invoke from a directory with a git origin.');
      }
      const resolved = await client.findProjectByRepoName(repoName);
      if (!resolved) {
        return noProjectResolved(pagination,
          `No DebuggAI project found for repo "${repoName}". Pass projectUuid explicitly.`);
      }
      projectUuid = resolved.uuid;
      project = { uuid: resolved.uuid };
      if (resolved.name) project.name = resolved.name;
      const rn = resolved.repo?.name ?? repoName;
      if (rn) project.repoName = rn;
    } else {
      project = { uuid: projectUuid };
    }

    // ── uuid mode ──
    if (input.uuid) {
      try {
        const env = await client.getEnvironment(projectUuid, input.uuid);
        const creds = await client.listCredentialsForEnvironment(projectUuid, input.uuid).catch(() => []);
        const payload = {
          project,
          filter: { uuid: input.uuid },
          pageInfo: { page: 1, pageSize: 1, totalCount: 1, totalPages: 1, hasMore: false },
          environments: [{ ...env, credentials: creds.map(stripPassword) }],
        };
        logger.toolComplete('search_environments', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.response?.status === 404) return notFound(input.uuid);
        throw err;
      }
    }

    // ── Filter mode ──
    const { pageInfo, environments } = await client.listEnvironmentsPaginated(projectUuid, pagination, input.q);

    // Expand creds per env (sequential — bounded by page size, typically ≤20)
    const withCreds = [];
    for (const env of environments) {
      const creds = await client.listCredentialsForEnvironment(projectUuid, env.uuid).catch(() => []);
      withCreds.push({ ...env, credentials: creds.map(stripPassword) });
    }

    const payload = {
      project,
      filter: { q: input.q ?? null },
      pageInfo,
      environments: withCreds,
    };
    logger.toolComplete('search_environments', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('search_environments', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'search_environments');
  }
}
