import { ListTeamsInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { toPaginationParams } from '../utils/pagination.js';

const logger = new Logger({ module: 'listTeamsHandler' });

export async function listTeamsHandler(
  input: ListTeamsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  const pagination = toPaginationParams({ page: input.page, pageSize: input.pageSize });
  logger.toolStart('list_teams', { q: input.q, ...pagination });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    const { pageInfo, teams } = await client.listTeams(pagination, input.q);

    const payload = {
      filter: { q: input.q ?? null },
      pageInfo,
      teams,
    };

    logger.toolComplete('list_teams', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('list_teams', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'list_teams');
  }
}
