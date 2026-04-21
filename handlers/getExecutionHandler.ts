import { GetExecutionInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';

const logger = new Logger({ module: 'getExecutionHandler' });

function notFound(uuid: string): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      error: 'NotFound',
      message: `Execution ${uuid} not found.`,
      uuid,
    }, null, 2) }],
    isError: true,
  };
}

export async function getExecutionHandler(
  input: GetExecutionInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('get_execution', { uuid: input.uuid });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    try {
      const execution = await client.workflows!.getExecution(input.uuid);
      logger.toolComplete('get_execution', Date.now() - start);
      return { content: [{ type: 'text', text: JSON.stringify({ execution }, null, 2) }] };
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.status === 404) return notFound(input.uuid);
      throw err;
    }
  } catch (error) {
    logger.toolError('get_execution', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'get_execution');
  }
}
