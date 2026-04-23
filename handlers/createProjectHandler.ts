import { CreateProjectInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';

const logger = new Logger({ module: 'createProjectHandler' });

function errorResp(error: string, message: string, extra: Record<string, any> = {}): ToolResponse {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error, message, ...extra }, null, 2),
    }],
    isError: true,
  };
}

interface Named { uuid: string; name: string }

/**
 * Resolve a name to a single uuid via backend search + exact (case-insensitive)
 * match. Returns either a uuid, a NotFound error, or an Ambiguous error with
 * candidate options surfaced.
 */
function resolveName(
  name: string,
  candidates: Named[],
  kind: 'Team' | 'Repo',
): { uuid: string } | { error: string; message: string; candidates?: Named[] } {
  const needle = name.toLowerCase();
  const matches = candidates.filter(c => c.name.toLowerCase() === needle);
  if (matches.length === 0) {
    return {
      error: `${kind}NotFound`,
      message: `No ${kind.toLowerCase()} matching "${name}" found. ` +
        (candidates.length > 0
          ? `Available: ${candidates.slice(0, 10).map(c => `"${c.name}"`).join(', ')}`
          : '(none accessible to this API key)'),
    };
  }
  if (matches.length > 1) {
    return {
      error: 'AmbiguousMatch',
      message: `Multiple ${kind.toLowerCase()}s match "${name}". Pass ${kind.toLowerCase()}Uuid explicitly.`,
      candidates: matches.map(m => ({ uuid: m.uuid, name: m.name })),
    };
  }
  return { uuid: matches[0].uuid };
}

export async function createProjectHandler(
  input: CreateProjectInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('create_project', {
    name: input.name, platform: input.platform,
    teamUuid: input.teamUuid, teamName: input.teamName,
    repoUuid: input.repoUuid, repoName: input.repoName,
  });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    // Resolve team
    let teamUuid = input.teamUuid;
    if (!teamUuid && input.teamName) {
      const teamsResp = await client.listTeams({ page: 1, pageSize: 100 }, input.teamName);
      const resolved = resolveName(input.teamName, teamsResp.teams, 'Team');
      if ('error' in resolved) return errorResp(resolved.error, resolved.message, { candidates: resolved.candidates });
      teamUuid = resolved.uuid;
    }

    // Resolve repo
    let repoUuid = input.repoUuid;
    if (!repoUuid && input.repoName) {
      const reposResp = await client.listRepos({ page: 1, pageSize: 100 }, input.repoName);
      const resolved = resolveName(input.repoName, reposResp.repos, 'Repo');
      if ('error' in resolved) return errorResp(resolved.error, resolved.message, { candidates: resolved.candidates });
      repoUuid = resolved.uuid;
    }

    if (!teamUuid || !repoUuid) {
      // Schema-level invariant should have caught this, but defensive.
      return errorResp(
        'ValidationError',
        `Unable to resolve ${!teamUuid ? 'team' : 'repo'} — provide teamUuid/teamName and repoUuid/repoName.`,
      );
    }

    const project = await client.createProject({
      name: input.name, platform: input.platform, teamUuid, repoUuid,
    });

    logger.toolComplete('create_project', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify({ created: true, project }, null, 2) }] };
  } catch (error) {
    logger.toolError('create_project', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'create_project');
  }
}
