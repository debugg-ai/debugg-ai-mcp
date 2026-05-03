import { SearchTestSuitesInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { resolveProject } from '../utils/resolveProject.js';

const logger = new Logger({ module: 'searchTestSuitesHandler' });

function errorResp(error: string, message: string, extra: Record<string, any> = {}): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message, ...extra }, null, 2) }], isError: true };
}

export async function searchTestSuitesHandler(
  input: SearchTestSuitesInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('search_test_suites', input);
  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let projectUuid = input.projectUuid;
    if (!projectUuid) {
      const resolved = await resolveProject(client, input.projectName!);
      if ('error' in resolved) return errorResp(resolved.error, resolved.message, { candidates: (resolved as any).candidates });
      projectUuid = resolved.uuid;
    }

    const result = await client.listTestSuites({
      projectUuid,
      search: input.search,
      page: input.page,
      pageSize: input.pageSize,
    });

    logger.toolComplete('search_test_suites', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    logger.toolError('search_test_suites', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'search_test_suites');
  }
}
