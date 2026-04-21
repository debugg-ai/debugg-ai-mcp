import {
  ListProjectsInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { toPaginationParams } from '../utils/pagination.js';

const logger = new Logger({ module: 'listProjectsHandler' });

export async function listProjectsHandler(
  input: ListProjectsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  const pagination = toPaginationParams({ page: input.page, pageSize: input.pageSize });
  logger.toolStart('list_projects', { q: input.q, ...pagination });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    const { pageInfo, projects } = await client.listProjects(pagination, input.q);

    const payload = {
      filter: { q: input.q ?? null },
      pageInfo,
      projects: projects.map(p => ({
        uuid: p.uuid,
        name: p.name,
        slug: p.slug,
        repoName: p.repo?.name ?? null,
      })),
    };

    logger.toolComplete('list_projects', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('list_projects', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'list_projects');
  }
}
