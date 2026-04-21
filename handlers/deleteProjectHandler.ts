import { DeleteProjectInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';

const logger = new Logger({ module: 'deleteProjectHandler' });

function notFound(uuid: string): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      error: 'NotFound',
      message: `Project ${uuid} not found.`,
      uuid,
    }, null, 2) }],
    isError: true,
  };
}

export async function deleteProjectHandler(
  input: DeleteProjectInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('delete_project', { uuid: input.uuid });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    try {
      await client.deleteProject(input.uuid);
      logger.toolComplete('delete_project', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ deleted: true, uuid: input.uuid }, null, 2) }],
      };
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.status === 404) return notFound(input.uuid);
      throw err;
    }
  } catch (error) {
    logger.toolError('delete_project', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'delete_project');
  }
}
