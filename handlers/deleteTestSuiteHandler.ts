import { DeleteTestSuiteInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { resolveProject, resolveTestSuite } from '../utils/resolveProject.js';

const logger = new Logger({ module: 'deleteTestSuiteHandler' });

function errorResp(error: string, message: string, extra: Record<string, any> = {}): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message, ...extra }, null, 2) }], isError: true };
}

export async function deleteTestSuiteHandler(
  input: DeleteTestSuiteInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('delete_test_suite', input);
  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let suiteUuid = input.suiteUuid;
    if (!suiteUuid) {
      let projectUuid = input.projectUuid;
      if (!projectUuid) {
        const resolved = await resolveProject(client, input.projectName!);
        if ('error' in resolved) return errorResp(resolved.error, resolved.message, { candidates: (resolved as any).candidates });
        projectUuid = resolved.uuid;
      }
      const resolved = await resolveTestSuite(client, input.suiteName!, projectUuid);
      if ('error' in resolved) return errorResp(resolved.error, resolved.message, { candidates: (resolved as any).candidates });
      suiteUuid = resolved.uuid;
    }

    await client.disableTestSuite(suiteUuid);
    logger.toolComplete('delete_test_suite', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, suiteUuid }, null, 2) }] };
  } catch (error) {
    logger.toolError('delete_test_suite', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'delete_test_suite');
  }
}
