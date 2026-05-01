/**
 * search_executions handler (bead 49b)
 *
 * Absorbs list_executions + get_execution.
 *
 * Modes:
 *   uuid: {uuid} → {filter:{uuid}, pageInfo:{totalCount:1,...}, executions:[fullDetail]}
 *                  fullDetail includes nodeExecutions, state, errorInfo.
 *   filter: {status?, projectUuid?, page?, pageSize?} → {filter, pageInfo, executions:[summary]}
 */

import {
  SearchExecutionsInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { toPaginationParams } from '../utils/pagination.js';

const logger = new Logger({ module: 'searchExecutionsHandler' });

function notFound(uuid: string): ToolResponse {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: 'NotFound', message: `Execution ${uuid} not found.`, uuid }, null, 2),
    }],
    isError: true,
  };
}

export async function searchExecutionsHandler(
  input: SearchExecutionsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('search_executions', input);

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    if (input.uuid) {
      try {
        const execution = await client.workflows!.getExecution(input.uuid);
        const payload = {
          filter: { uuid: input.uuid },
          pageInfo: { page: 1, pageSize: 1, totalCount: 1, totalPages: 1, hasMore: false },
          executions: [execution],
        };
        logger.toolComplete('search_executions', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.response?.status === 404) return notFound(input.uuid);
        throw err;
      }
    }

    const pagination = toPaginationParams({ page: input.page, pageSize: input.pageSize });
    const { pageInfo, executions } = await client.workflows!.listExecutions({
      status: input.status,
      projectId: input.projectUuid,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    const payload = {
      filter: {
        status: input.status ?? null,
        projectUuid: input.projectUuid ?? null,
      },
      pageInfo,
      executions,
    };
    logger.toolComplete('search_executions', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('search_executions', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'search_executions');
  }
}
