import { DeleteTestCaseInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';

const logger = new Logger({ module: 'deleteTestCaseHandler' });

export async function deleteTestCaseHandler(
  input: DeleteTestCaseInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('delete_test_case', input);
  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    await client.disableTestCase(input.testUuid);
    logger.toolComplete('delete_test_case', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, testUuid: input.testUuid }, null, 2) }] };
  } catch (error) {
    logger.toolError('delete_test_case', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'delete_test_case');
  }
}
