import {
  ListEnvironmentsInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';
import { toPaginationParams, makePageInfo } from '../utils/pagination.js';

const logger = new Logger({ module: 'listEnvironmentsHandler' });

export async function listEnvironmentsHandler(
  input: ListEnvironmentsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  const pagination = toPaginationParams({ page: input.page, pageSize: input.pageSize });
  logger.toolStart('list_environments', { projectUuid: input.projectUuid, q: input.q, ...pagination });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let projectUuid = input.projectUuid;
    let projectName: string | null = null;
    let projectRepoName: string | null = null;

    if (!projectUuid) {
      const repoName = detectRepoName();
      if (!repoName) {
        const payload = {
          error: 'NoProjectResolved',
          message: 'No git repo detected and no projectUuid provided. Pass projectUuid (get it from list_projects) or invoke from a directory with a git origin.',
          pageInfo: makePageInfo(pagination.page, pagination.pageSize, 0, null),
          environments: [],
        };
        logger.toolComplete('list_environments', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
      const project = await client.findProjectByRepoName(repoName);
      if (!project) {
        const payload = {
          error: 'NoProjectResolved',
          message: `No DebuggAI project found for repo "${repoName}". Pass projectUuid explicitly or call list_projects to discover.`,
          pageInfo: makePageInfo(pagination.page, pagination.pageSize, 0, null),
          environments: [],
        };
        logger.toolComplete('list_environments', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
      projectUuid = project.uuid;
      projectName = project.name;
      projectRepoName = project.repo?.name ?? repoName;
    }

    const { pageInfo, environments } = await client.listEnvironmentsPaginated(projectUuid, pagination, input.q);

    const payload = {
      project: {
        uuid: projectUuid,
        name: projectName,
        repoName: projectRepoName,
      },
      filter: { q: input.q ?? null },
      pageInfo,
      environments,
    };

    logger.toolComplete('list_environments', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('list_environments', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'list_environments');
  }
}
