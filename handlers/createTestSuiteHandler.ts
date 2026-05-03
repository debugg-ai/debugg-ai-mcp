import { CreateTestSuiteInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { resolveProject } from '../utils/resolveProject.js';

const logger = new Logger({ module: 'createTestSuiteHandler' });

function errorResp(error: string, message: string, extra: Record<string, any> = {}): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message, ...extra }, null, 2) }], isError: true };
}

export async function createTestSuiteHandler(
  input: CreateTestSuiteInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('create_test_suite', input);
  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let projectUuid = input.projectUuid;
    if (!projectUuid) {
      const resolved = await resolveProject(client, input.projectName!);
      if ('error' in resolved) return errorResp(resolved.error, resolved.message, { candidates: resolved.candidates });
      projectUuid = resolved.uuid;
    }

    const suite = await client.createTestSuite({ name: input.name, description: input.description, projectUuid });
    logger.toolComplete('create_test_suite', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(suite, null, 2) }] };
  } catch (error) {
    logger.toolError('create_test_suite', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'create_test_suite');
  }
}
