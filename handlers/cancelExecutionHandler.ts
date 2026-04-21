import { CancelExecutionInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';

const logger = new Logger({ module: 'cancelExecutionHandler' });

function errorResponse(error: string, message: string, uuid: string): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error, message, uuid }, null, 2) }],
    isError: true,
  };
}

export async function cancelExecutionHandler(
  input: CancelExecutionInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('cancel_execution', { uuid: input.uuid });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    try {
      await client.workflows!.cancelExecution(input.uuid);
      logger.toolComplete('cancel_execution', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ cancelled: true, uuid: input.uuid }, null, 2) }],
      };
    } catch (err: any) {
      const status = err?.statusCode ?? err?.response?.status;
      const detail = err?.responseData?.error ?? err?.message ?? '';
      if (status === 404) {
        return errorResponse('NotFound', `Execution ${input.uuid} not found.`, input.uuid);
      }
      if (status === 409 || /already|completed|cannot.?cancel/i.test(detail)) {
        return errorResponse('AlreadyCompleted', detail || `Execution ${input.uuid} cannot be cancelled.`, input.uuid);
      }
      throw err;
    }
  } catch (error) {
    logger.toolError('cancel_execution', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'cancel_execution');
  }
}
