import {
  UpdateEnvironmentInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';

const logger = new Logger({ module: 'updateEnvironmentHandler' });

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

export async function updateEnvironmentHandler(
  input: UpdateEnvironmentInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('update_environment', {
    uuid: input.uuid,
    patchKeys: Object.keys(input).filter(k => k !== 'uuid' && k !== 'projectUuid'),
    projectUuid: input.projectUuid,
  });

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
      const environment = await client.updateEnvironment(projectUuid, input.uuid, {
        name: input.name,
        url: input.url,
        description: input.description,
      });
      logger.toolComplete('update_environment', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ updated: true, environment }, null, 2) }],
      };
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.status === 404) {
        return notFound(input.uuid, `backend returned 404 for project ${projectUuid}`);
      }
      throw err;
    }
  } catch (error) {
    logger.toolError('update_environment', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'update_environment');
  }
}
