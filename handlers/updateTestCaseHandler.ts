import { UpdateTestCaseInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';

const logger = new Logger({ module: 'updateTestCaseHandler' });

export async function updateTestCaseHandler(
  input: UpdateTestCaseInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('update_test_case', input);
  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    const updated = await client.updateTestCase(input.testUuid, {
      name: input.name,
      description: input.description,
      agentTaskDescription: input.agentTaskDescription,
    });

    logger.toolComplete('update_test_case', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
  } catch (error) {
    logger.toolError('update_test_case', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'update_test_case');
  }
}
