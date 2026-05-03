import { CreateTestCaseInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { resolveProject, resolveTestSuite } from '../utils/resolveProject.js';

const logger = new Logger({ module: 'createTestCaseHandler' });

function errorResp(error: string, message: string, extra: Record<string, any> = {}): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message, ...extra }, null, 2) }], isError: true };
}

export async function createTestCaseHandler(
  input: CreateTestCaseInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('create_test_case', input);
  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let projectUuid = input.projectUuid;
    if (!projectUuid) {
      const resolved = await resolveProject(client, input.projectName!);
      if ('error' in resolved) return errorResp(resolved.error, resolved.message, { candidates: (resolved as any).candidates });
      projectUuid = resolved.uuid;
    }

    let suiteUuid = input.suiteUuid;
    if (!suiteUuid) {
      const resolved = await resolveTestSuite(client, input.suiteName!, projectUuid);
      if ('error' in resolved) return errorResp(resolved.error, resolved.message, { candidates: (resolved as any).candidates });
      suiteUuid = resolved.uuid;
    }

    const testCase = await client.createTestCase({
      name: input.name,
      description: input.description,
      agentTaskDescription: input.agentTaskDescription,
      suiteUuid,
      projectUuid,
      relativeUrl: input.relativeUrl,
      maxSteps: input.maxSteps,
    });

    logger.toolComplete('create_test_case', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(testCase, null, 2) }] };
  } catch (error) {
    logger.toolError('create_test_case', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'create_test_case');
  }
}
