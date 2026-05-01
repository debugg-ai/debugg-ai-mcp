/**
 * search_projects handler (bead ue3)
 *
 * Single tool covering both uuid-lookup and filter/list modes.
 *
 * Modes:
 *   uuid mode:   {uuid} → {filter:{uuid}, pageInfo:{totalCount:1,...}, projects:[fullProject]}
 *                — NotFound surfaces as isError:true
 *   filter mode: {q?, page?, pageSize?} → {filter:{q}, pageInfo, projects:[summaries]}
 *
 * Response shape is uniform ({filter, pageInfo, projects}) but `projects[0]`
 * richness differs by mode: uuid-mode returns the full project (all backend
 * keys), filter-mode returns a summary (uuid/name/slug/repoName).
 */

import { SearchProjectsInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { toPaginationParams } from '../utils/pagination.js';

const logger = new Logger({ module: 'searchProjectsHandler' });

function notFound(uuid: string): ToolResponse {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: 'NotFound', message: `Project ${uuid} not found.`, uuid }, null, 2),
    }],
    isError: true,
  };
}

export async function searchProjectsHandler(
  input: SearchProjectsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('search_projects', input);

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    if (input.uuid) {
      try {
        const project = await client.getProject(input.uuid);
        const payload = {
          filter: { uuid: input.uuid },
          pageInfo: { page: 1, pageSize: 1, totalCount: 1, totalPages: 1, hasMore: false },
          projects: [project],
        };
        logger.toolComplete('search_projects', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.response?.status === 404) return notFound(input.uuid);
        throw err;
      }
    }

    const pagination = toPaginationParams({ page: input.page, pageSize: input.pageSize });
    const { pageInfo, projects } = await client.listProjects(pagination, input.q);

    const payload = {
      filter: { q: input.q ?? null },
      pageInfo,
      projects: projects.map((p: any) => ({
        uuid: p.uuid,
        name: p.name,
        slug: p.slug,
        repoName: p.repo?.name ?? null,
      })),
    };
    logger.toolComplete('search_projects', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('search_projects', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'search_projects');
  }
}
