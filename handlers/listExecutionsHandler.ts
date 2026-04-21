import { ListExecutionsInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { toPaginationParams } from '../utils/pagination.js';

const logger = new Logger({ module: 'listExecutionsHandler' });

export async function listExecutionsHandler(
  input: ListExecutionsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  const pagination = toPaginationParams({ page: input.page, pageSize: input.pageSize });
  logger.toolStart('list_executions', { status: input.status, projectUuid: input.projectUuid, ...pagination });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

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

    logger.toolComplete('list_executions', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('list_executions', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'list_executions');
  }
}
