import { UpdateProjectInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';

const logger = new Logger({ module: 'updateProjectHandler' });

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

export async function updateProjectHandler(
  input: UpdateProjectInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('update_project', {
    uuid: input.uuid,
    patchKeys: Object.keys(input).filter(k => k !== 'uuid'),
  });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    try {
      const project = await client.updateProject(input.uuid, {
        name: input.name,
        description: input.description,
      });
      logger.toolComplete('update_project', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ updated: true, project }, null, 2) }],
      };
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.status === 404) return notFound(input.uuid);
      throw err;
    }
  } catch (error) {
    logger.toolError('update_project', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'update_project');
  }
}
