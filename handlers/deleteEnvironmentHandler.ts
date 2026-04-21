import {
  DeleteEnvironmentInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';

const logger = new Logger({ module: 'deleteEnvironmentHandler' });

function notFound(uuid: string, context: string): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      error: 'NotFound',
      message: `Environment ${uuid} not found (${context}).`,
      uuid,
    }, null, 2) }],
    isError: true,
  };
}

export async function deleteEnvironmentHandler(
  input: DeleteEnvironmentInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('delete_environment', { uuid: input.uuid, projectUuid: input.projectUuid });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let projectUuid = input.projectUuid;
    if (!projectUuid) {
      const repoName = detectRepoName();
      if (!repoName) return notFound(input.uuid, 'no git repo detected and no projectUuid provided');
      const project = await client.findProjectByRepoName(repoName);
      if (!project) return notFound(input.uuid, `no project found for repo "${repoName}"`);
      projectUuid = project.uuid;
    }

    try {
      await client.deleteEnvironment(projectUuid, input.uuid);
      logger.toolComplete('delete_environment', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ deleted: true, uuid: input.uuid }, null, 2) }],
      };
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.status === 404) {
        return notFound(input.uuid, `backend returned 404 for project ${projectUuid}`);
      }
      throw err;
    }
  } catch (error) {
    logger.toolError('delete_environment', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'delete_environment');
  }
}
