import {
  ListCredentialsInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';
import { toPaginationParams, makePageInfo } from '../utils/pagination.js';

const logger = new Logger({ module: 'listCredentialsHandler' });

export async function listCredentialsHandler(
  input: ListCredentialsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  const pagination = toPaginationParams({ page: input.page, pageSize: input.pageSize });
  logger.toolStart('list_credentials', {
    environmentId: input.environmentId,
    projectUuid: input.projectUuid,
    q: input.q,
    role: input.role,
    ...pagination,
  });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let projectUuid = input.projectUuid;
    if (!projectUuid) {
      const repoName = detectRepoName();
      if (!repoName) {
        const payload = {
          error: 'NoProjectResolved',
          message: 'No git repo detected and no projectUuid provided. Pass projectUuid (get it from list_projects) or invoke from a directory with a git origin.',
          pageInfo: makePageInfo(pagination.page, pagination.pageSize, 0, null),
          credentials: [],
        };
        logger.toolComplete('list_credentials', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
      const project = await client.findProjectByRepoName(repoName);
      if (!project) {
        const payload = {
          error: 'NoProjectResolved',
          message: `No DebuggAI project found for repo "${repoName}". Pass projectUuid explicitly.`,
          pageInfo: makePageInfo(pagination.page, pagination.pageSize, 0, null),
          credentials: [],
        };
        logger.toolComplete('list_credentials', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
      projectUuid = project.uuid;
    }

    let pageInfo;
    let credentials: Array<{ uuid: string; label: string; username: string; role: string | null; environmentUuid: string }> = [];

    if (input.environmentId) {
      // Paginated path — scoped to a single env.
      const result = await client.listCredentialsPaginated(
        projectUuid, input.environmentId, pagination, input.q, input.role,
      );
      pageInfo = result.pageInfo;
      credentials = result.credentials;
    } else {
      // No env filter — iterate all envs and merge. Synthesize pageInfo from the full
      // result (client-side paginate the merged list for consistent shape).
      const envs = await client.listEnvironmentsForProject(projectUuid);
      const all: typeof credentials = [];
      for (const env of envs) {
        const credsForEnv = await client.listCredentialsForEnvironment(
          projectUuid, env.uuid, input.q, input.role,
        );
        all.push(...credsForEnv);
      }
      const offset = (pagination.page - 1) * pagination.pageSize;
      credentials = all.slice(offset, offset + pagination.pageSize);
      const totalCount = all.length;
      const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pagination.pageSize);
      pageInfo = {
        page: pagination.page,
        pageSize: pagination.pageSize,
        totalCount,
        totalPages,
        hasMore: offset + credentials.length < totalCount,
      };
    }

    const payload = {
      project: { uuid: projectUuid },
      filter: {
        environmentId: input.environmentId ?? null,
        q: input.q ?? null,
        role: input.role ?? null,
      },
      pageInfo,
      credentials,
    };

    logger.toolComplete('list_credentials', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('list_credentials', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'list_credentials');
  }
}
